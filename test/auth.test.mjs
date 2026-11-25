// 授权流程测试：?auth=error 不再自动跳授权（打破 401 死循环）、会话中途 401 的提示与草稿 flush
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { waitForBoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const here = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.resolve(here, '..');

let checks = 0;
let failed = 0;
function check(ok, label, extra) {
  checks += 1;
  if (!ok) {
    failed += 1;
    console.log(`✗ ${label}` + (extra ? `\n    ${extra}` : ''));
  }
}

/**
 * 启动一个 DOM 实例。
 * @param {string} url 打开的地址（用来带 ?auth=error）
 * @param {{status?:Function, listPosts?:Function}} stubs GitHubStore 桩
 */
async function boot(url, stubs) {
  const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8')
    .replace(/<script src="assets\/[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.clear?.();
  const calls = { login: 0, status: 0 };

  for (const file of ['core.js', 'github.js']) {
    w.eval(fs.readFileSync(path.join(editorDir, 'assets', file), 'utf8'));
  }
  // 覆盖网络层，避免 jsdom 里真的发请求
  w.GitHubStore.login = () => { calls.login += 1; };
  w.GitHubStore.status = () => {
    calls.status += 1;
    return Promise.resolve(stubs && stubs.status ? stubs.status() : { ok: false, error: 500, message: 'stub' });
  };
  w.eval(fs.readFileSync(path.join(editorDir, 'assets', 'app.js'), 'utf8'));

  await waitForBoot(dom);
  return { dom, w, calls };
}

/* ================================================================
 * 用例 1：?auth=error 停在引导页，不请求 status、不跳授权
 * ================================================================ */
{
  const { w, calls } = await boot('http://localhost/tools/online-hexo-editor/?auth=error&reason=state_mismatch');

  check(calls.status === 0, '授权失败时不应再请求 GitHubStore.status()', 'status 被调用了 ' + calls.status + ' 次');
  check(calls.login === 0, '授权失败时不应自动跳授权页', 'login 被调用了 ' + calls.login + ' 次');
  check(!w.document.getElementById('auth-error').classList.contains('hidden'), '引导页应显示授权失败提示');

  const reason = w.document.getElementById('auth-error-reason').textContent;
  check(/state 不匹配/.test(reason), '失败原因应翻译成中文', '实际：' + reason);
  check(w.document.getElementById('empty-steps').classList.contains('hidden'), '失败态应隐藏正常步骤说明');
  check(w.document.getElementById('empty-hint').classList.contains('hidden'), '失败态应隐藏底部提示');
  check(!!w.document.getElementById('btn-auth-retry'), '失败态应提供「重新登录」按钮');

  w.document.getElementById('btn-auth-retry').click();
  check(calls.login === 1, '点「重新登录」才发起授权', 'login 次数：' + calls.login);
}

/* ================================================================
 * 用例 2：未知 reason 也要有兜底文案
 * ================================================================ */
{
  const { w } = await boot('http://localhost/tools/online-hexo-editor/?auth=error&reason=weird_thing');
  const reason = w.document.getElementById('auth-error-reason').textContent;
  check(/授权没有完成/.test(reason), '未知 reason 用兜底文案', '实际：' + reason);
}

/* ================================================================
 * 用例 3：会话中途 401 → 弹提示、flush 草稿、可稍后关闭
 * ================================================================ */
{
  const { w } = await boot('http://localhost/');
  const ed = w.HexoEditor;
  const p = ed.loadFromText('t.md', '---\ntitle: 测试\nabbrlink: abc\n---\n\n正文\n', { isNew: true, dirty: true });
  check(p.dirty === true, '新建文章标记为有改动');

  // 真实走 request()：fetch 返回 401，应由 github.js 派发事件
  w.fetch = () => Promise.resolve({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({ message: 'not signed in' })
  });
  await w.GitHubStore.request('').catch(() => {});

  const box = w.document.getElementById('auth-expired');
  check(!box.classList.contains('hidden'), '中途 401 应弹出登录过期提示');
  const text = w.document.getElementById('auth-expired-text').textContent;
  check(/本地草稿/.test(text), '提示应说明改动已存到本地草稿', '实际：' + text);

  const keys = Object.keys(w.localStorage);
  check(keys.some(k => k.indexOf('hexo-editor:draft:v2:') === 0), '弹提示前应把防抖中的草稿写入 localStorage', '实际键：' + keys.join(','));

  w.document.getElementById('btn-auth-later').click();
  check(box.classList.contains('hidden'), '点「稍后」应关闭提示');
}

console.log(`\n授权流程断言 ${checks} 条，失败 ${failed} 条`);
process.exitCode = failed ? 1 : 0;
