// 上传链路的集成测试：真实加载 index.html + 三个脚本，拖入非图片文件必须被拦在前端
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

function pngBytes() {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(2, 20);
  return new Uint8Array(b);
}

const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8')
  .replace(/<script src="assets\/[^"]+"><\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.localStorage.clear?.();
w.indexedDB = undefined;

for (const file of ['core.js', 'github.js']) {
  w.eval(fs.readFileSync(path.join(editorDir, 'assets', file), 'utf8'));
}

const calls = { blob: 0, tree: 0, commit: 0, ref: 0 };
w.GitHubStore.status = () => Promise.resolve({ ok: false, error: 500, message: 'stub' });
w.GitHubStore.login = () => {};
w.GitHubStore.createBlobBase64 = () => { calls.blob += 1; return Promise.resolve('blob-sha'); };
w.GitHubStore.branchHead = () => Promise.resolve('head-sha');
w.GitHubStore.getCommit = () => Promise.resolve({ sha: 'head-sha', tree: { sha: 'tree-sha' } });
w.GitHubStore.createTree = () => { calls.tree += 1; return Promise.resolve('new-tree'); };
w.GitHubStore.createCommit = () => { calls.commit += 1; return Promise.resolve({ sha: 'commit-sha' }); };
w.GitHubStore.updateRef = () => { calls.ref += 1; return Promise.resolve({}); };

w.eval(fs.readFileSync(path.join(editorDir, 'assets', 'app.js'), 'utf8'));
await waitForBoot(dom);

const E = w.HexoEditor;
const post = E.loadFromText('t.md', '---\ntitle: 测试\nabbrlink: abc\n---\n\n正文\n', { dirty: true });
post.draft = { branch: 'draft/abc', base: 'main-sha', head: 'head-sha' };
post.readOnly = false;
E.state.current = post;

function makeFile(bytes, name, type) {
  const f = new w.File([bytes], name, { type });
  // jsdom 20 的 File 没有 arrayBuffer()，按实例补一个
  f.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return f;
}

await E.uploadImages([
  makeFile(pngBytes(), 'shot.png', 'image/png'),
  makeFile(new Uint8Array(Buffer.from('<% process.env.SECRET %>')), 'evil.ejs', 'application/octet-stream'),
  makeFile(new Uint8Array(Buffer.from('%PDF-1.7')), 'doc.pdf', 'application/pdf'),
]);

check(calls.blob === 1, '只有合法 PNG 应该创建 blob', '实际 ' + calls.blob + ' 次');
check(calls.tree === 1 && calls.commit === 1 && calls.ref === 1, '上传链路只应跑一次', JSON.stringify(calls));

const body = E.getBody();
const links = body.match(/!\[\]\(\/images\/\d{4}\/\d{2}\/[A-Za-z0-9]+\.png\)/g) || [];
check(links.length === 1, '正文里应只插入一张图片', '实际：' + JSON.stringify(body.slice(0, 120)));

const toastText = w.document.getElementById('toast').textContent || '';
check(/跳过 2 个文件/.test(toastText), '应汇总提示跳过了 2 个文件', '实际：' + toastText);

console.log(`\n上传链路断言 ${checks} 条，失败 ${failed} 条`);
process.exitCode = failed ? 1 : 0;
