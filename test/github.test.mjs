// GitHub 模式：列表的标题 / 日期 / 标签来自 front matter，而不是文件名。
// 全部用 mock fetch 跑，不发真实网络请求。
// 用法：node test/github.test.mjs
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

const REPO = 'XieYu-Zk/ZEROKAMI-STUDIO';
const API = '/api/github/repos/' + REPO;

/* 三篇虚构文章：日期跨度足够验证排序，标签有交集也有独有 */
const POSTS = [
  { name: '30 排序测试.md', sha: 'sha30', title: '排序测试', date: '2026-11-20 10:00:00',
    tags: ['测试', '格式'], abbrlink: 'aaa111', body: '正文三十' },
  { name: '28 中间一篇.md', sha: 'sha28', title: '中间一篇', date: '2026-10-01 09:30:00',
    tags: ['测试'], abbrlink: 'bbb222', body: '正文二十八' },
  { name: '12 最早一篇.md', sha: 'sha12', title: '最早一篇', date: '2025-01-05 08:00:00',
    tags: ['生活'], abbrlink: 'ccc333', body: '正文十二' }
];

function rawOf(p) {
  return [
    '---',
    'title: ' + p.title,
    'date: ' + p.date,
    'tags: [' + p.tags.join(', ') + ']',
    'abbrlink: ' + p.abbrlink,
    '---',
    '',
    p.body,
    ''
  ].join('\n');
}

function jsonRes(data, status) {
  status = status || 200;
  return Promise.resolve({
    ok: status < 400,
    status: status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data))
  });
}

async function boot() {
  const html = fs.readFileSync(path.join(editorDir, 'index.html'), 'utf8')
    .replace(/<script src="assets\/[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.indexedDB = undefined;                 // 不落缓存，每次都是冷启动
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  w.HEXO_EDITOR_REPO = REPO;
  for (const file of ['core.js', 'github.js', 'app.js']) {
    w.eval(fs.readFileSync(path.join(editorDir, 'assets', file), 'utf8'));
  }
  await waitForBoot(dom);
  return dom;
}

async function waitFor(fn, label, timeout) {
  const deadline = Date.now() + (timeout || 4000);
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout: ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ---------------- 1. 列表元信息来自 front matter ---------------- */
{
  const dom = await boot();
  const w = dom.window;
  const d = w.document;

  const calls = [];
  w.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u === API) {
      return jsonRes({ full_name: REPO, default_branch: 'main', private: true, permissions: { push: true } });
    }
    if (u === API + '/git/ref/heads/main') return jsonRes({ object: { sha: 'headsha' } });
    if (u === API + '/git/trees/headsha?recursive=1') {
      return jsonRes({
        tree: POSTS.map((p) => ({
          path: 'source/_posts/' + p.name, mode: '100644', type: 'blob', sha: p.sha, size: 200
        }))
      });
    }
    const blob = u.match(/\/git\/blobs\/([^/?]+)$/);
    if (blob) {
      const post = POSTS.find((p) => p.sha === blob[1]);
      if (!post) return jsonRes({ message: 'unknown sha' }, 404);
      return jsonRes({ sha: post.sha, encoding: 'base64', content: Buffer.from(rawOf(post), 'utf8').toString('base64') });
    }
    const contents = u.match(/\/contents\/(.+)\?ref=main$/);
    if (contents) {
      const name = decodeURI(contents[1]).replace('source/_posts/', '');
      const post = POSTS.find((p) => p.name === name);
      if (!post) return jsonRes({ message: 'not found' }, 404);
      return jsonRes({ sha: post.sha, encoding: 'base64', content: Buffer.from(rawOf(post), 'utf8').toString('base64') });
    }
    return jsonRes({ message: 'not mocked: ' + u }, 404);
  };

  const ghCard = Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent));
  check(!!ghCard, '启动选择器里有「GitHub 仓库」', d.querySelector('#modal-body')?.textContent);

  /* 入口常驻：关掉启动弹窗后，左下角仍能再次切换工作方式 */
  d.querySelector('#modal-close').click();
  await waitFor(() => d.querySelector('#modal').classList.contains('hidden'), '关闭启动选择器');
  const ghEntry = d.querySelector('#dot-github');
  check(!!ghEntry && !ghEntry.classList.contains('hidden'), '本地/未连接时也常驻 GitHub 入口');
  check(!ghEntry.classList.contains('on'), '未连接时 GitHub 入口是灰的');
  check(ghEntry.textContent.trim() === 'GitHub', '未连接时标签只有 GitHub', ghEntry.textContent.trim());
  ghEntry.click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '点入口重新打开工作方式');
  check(d.querySelector('#modal-title').textContent === '选择工作方式', '入口打开「选择工作方式」',
    d.querySelector('#modal-title').textContent);
  const card2 = Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent));
  card2.click();

  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '列表渲染出 3 篇');
  await waitFor(() => {
    const t = d.querySelector('#post-list li .p-title');
    return t && t.textContent !== '30 排序测试';
  }, '标题被 front matter 覆盖');

  const items = Array.from(d.querySelectorAll('#post-list li'));
  const titles = items.map((li) => li.querySelector('.p-title').textContent);
  check(titles.join('|') === '排序测试|中间一篇|最早一篇', '按 date 倒序，标题取 front matter', titles.join('|'));

  const meta0 = items[0].querySelector('.p-meta').textContent;
  check(meta0.indexOf('2026-11-20') !== -1, '第一项显示日期', meta0);
  check(meta0.indexOf('测试 / 格式') !== -1, '第一项显示 tags（/ 分隔）', meta0);

  check(d.querySelector('#post-list li .p-title').textContent !== '30 排序测试.md', '不再显示文件名');

  const tagBtns = Array.from(d.querySelectorAll('#tag-filter .tagbtn')).map((b) => b.textContent);
  check(tagBtns.indexOf('测试 2') !== -1, '标签筛选按 front matter 统计：测试 2', tagBtns.join(' | '));
  check(tagBtns.indexOf('格式 1') !== -1, '标签筛选：格式 1', tagBtns.join(' | '));
  check(tagBtns.indexOf('生活 1') !== -1, '标签筛选：生活 1', tagBtns.join(' | '));

  check(d.querySelector('#count-info').textContent === '3 / 3 篇', '计数为 3 / 3', d.querySelector('#count-info').textContent);

  const blobCalls = calls.filter((u) => /\/git\/blobs\//.test(u)).length;
  check(blobCalls === 3, '每篇只读一次 blob', String(blobCalls));
  check(!calls.some((u) => /\/contents\//.test(u)), '列表阶段不拉正文（contents API）');

  /* 搜索也能命中 front matter 标题 */
  const search = d.querySelector('#search');
  search.value = '中间';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitFor(() => d.querySelectorAll('#post-list li').length === 1, '搜索命中 1 篇');
  check(d.querySelector('#post-list li .p-title').textContent === '中间一篇', '搜索按标题过滤');
  search.value = '';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '清空搜索恢复 3 篇');

  /* 打开文章：正文已有，不需要再请求 */
  const before = calls.length;
  items[0].click();
  await waitFor(() => d.querySelector('#body').textContent.indexOf('正文三十') !== -1, '正文渲染');
  check(calls.length === before, '打开已预载的文章不再发请求', String(calls.length - before));
  check(d.querySelector('#f-title').value === '排序测试', '属性区回填 title', d.querySelector('#f-title').value);
  check(d.querySelector('#f-date').value === '2026-11-20 10:00:00', '属性区回填 date', d.querySelector('#f-date').value);
  check(d.querySelectorAll('#tags-chips .chip').length === 2, '属性区回填 2 个标签');
  check(!d.querySelector('#readonly-hint').classList.contains('hidden'), 'main 上的文章仍是只读');
  check(d.querySelector('#btn-save').classList.contains('hidden'), '只读态隐藏保存按钮');

  /* 左下角状态：GitHub 模式只显示仓库态，两个本地目录圆点收起 */
  const dotGh = d.querySelector('#dot-github');
  check(!!dotGh, '存在 GitHub 状态按钮');
  check(!dotGh.classList.contains('hidden'), 'GitHub 模式下显示仓库状态');
  check(dotGh.classList.contains('on'), '仓库状态为已连接（绿）');
  check(dotGh.textContent.indexOf('3 篇') !== -1, '状态里带篇数', dotGh.textContent.trim());
  check(d.querySelector('#dot-posts').classList.contains('hidden'), '文章目录圆点已隐藏');
  check(d.querySelector('#dot-images').classList.contains('hidden'), '图片目录圆点已隐藏');

  /* 点状态 → 仓库信息弹窗 */
  dotGh.click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '仓库信息弹窗打开');
  check(d.querySelector('#modal-title').textContent === 'GitHub 仓库', '弹窗标题为「GitHub 仓库」',
    d.querySelector('#modal-title').textContent);
  const infoBtns = Array.from(d.querySelectorAll('#modal-foot .btn')).map((b) => b.textContent);
  check(infoBtns.indexOf('切换为本地目录') !== -1, '仓库信息里可切回本地目录', infoBtns.join(' | '));
  check(infoBtns.indexOf('重新读取') !== -1, '仓库信息里可重新读取', infoBtns.join(' | '));
  d.querySelector('#modal-close').click();
  await waitFor(() => d.querySelector('#modal').classList.contains('hidden'), '弹窗关闭');

  /* 刷新按钮：重新读取 GitHub 列表，不再掉进「选择文件夹」 */
  const blobsBefore = calls.filter((u) => /\/git\/blobs\//.test(u)).length;
  d.querySelector('#btn-refresh').click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '刷新后仍是 3 篇');
  await new Promise((r) => setTimeout(r, 200));
  const blobsAfter = calls.filter((u) => /\/git\/blobs\//.test(u)).length;
  check(blobsAfter === blobsBefore, '刷新走缓存，不重复拉 blob', blobsBefore + ' -> ' + blobsAfter);
  const titlesAfter = Array.from(d.querySelectorAll('#post-list li .p-title')).map((x) => x.textContent);
  check(titlesAfter.join('|') === '排序测试|中间一篇|最早一篇', '刷新后标题仍是 front matter 的',
    titlesAfter.join('|'));
  check(d.querySelector('#modal').classList.contains('hidden'), '刷新不会弹出文件夹选择框');
  check(!d.querySelector('#toast') || d.querySelector('#toast').textContent.indexOf('刷新失败') === -1,
    '刷新没有报错提示');

  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

/* ---------------- 2. readBlobs：并发上限与失败计数 ---------------- */
{
  const dom = await boot();
  const w = dom.window;
  let inflight = 0;
  let maxInflight = 0;
  const items = Array.from({ length: 9 }, (_, i) => ({ sha: 's' + i }));
  w.fetch = (url) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    const ok = !/s7$/.test(String(url));
    return new Promise((resolve) => {
      setTimeout(() => {
        inflight -= 1;
        if (!ok) return resolve({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ message: 'boom' }) });
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: () => Promise.resolve({ encoding: 'base64', content: Buffer.from('x', 'utf8').toString('base64') })
        });
      }, 8);
    });
  };
  const res = await w.GitHubStore.readBlobs(items, () => {}, { concurrency: 3 });
  check(maxInflight <= 3, '并发不超过 concurrency', String(maxInflight));
  check(maxInflight === 3, '并发确实跑到 3', String(maxInflight));
  check(res.done === 8 && res.failed === 1, '单个失败不中断其余', JSON.stringify(res));
  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

/* ---------------- 3. 编辑 → 保存草稿分支 → 发布 ---------------- */

/** 一个够用的内存 Git：blob / tree / commit / ref，行为按 GitHub 的几个端点模拟 */
function makeGitServer(posts) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map();
  let seq = 0;
  const nid = (c) => c + (++seq);
  const setBlob = (text) => { const sha = nid('b'); blobs.set(sha, text); return sha; };
  const setTree = (entries) => { const sha = nid('t'); trees.set(sha, new Map(entries)); return sha; };
  const setCommit = (message, tree, parents) => {
    const sha = nid('c'); commits.set(sha, { message, tree, parents }); return sha;
  };

  const seed = new Map();
  posts.forEach((p) => seed.set('source/_posts/' + p.name, setBlob(rawOf(p))));
  const firstTree = setTree(seed);
  const firstCommit = setCommit('init', firstTree, []);
  refs.set('main', firstCommit);

  const treeOf = (sha) => {
    const c = commits.get(sha);
    return new Map(trees.get(c ? c.tree : sha) || new Map());
  };

  function diff(base, head) {
    const a = treeOf(base), b = treeOf(head);
    const files = [];
    new Set([...a.keys(), ...b.keys()]).forEach((p) => {
      const x = a.get(p), y = b.get(p);
      if (x === y) return;
      if (x && !y) files.push({ filename: p, status: 'removed', sha: null });
      else if (!x && y) files.push({ filename: p, status: 'added', sha: y });
      else files.push({ filename: p, status: 'modified', sha: y });
    });
    return { files, ahead_by: files.length };
  }

  function handle(rawUrl, init) {
    const method = (init && init.method) || 'GET';
    const u = String(rawUrl);
    const q = u.indexOf('?');
    const clean = q === -1 ? u : u.slice(0, q);
    const rel = clean.replace(API, '');
    const body = init && init.body ? JSON.parse(init.body) : null;
    let m;

    if (rel === '' || rel === '/') {
      return jsonRes({ full_name: REPO, default_branch: 'main', private: true, permissions: { push: true } });
    }
    if (method === 'GET' && (m = rel.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[1]);
      const sha = refs.get(branch);
      return sha
        ? jsonRes({ ref: 'refs/heads/' + branch, object: { sha } })
        : jsonRes({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && rel === '/git/matching-refs/heads/draft/') {
      return jsonRes([...refs.keys()].filter((b) => b.startsWith('draft/'))
        .map((b) => ({ ref: 'refs/heads/' + b, object: { sha: refs.get(b) } })));
    }
    if (method === 'GET' && (m = rel.match(/^\/git\/trees\/(.+)$/))) {
      const map = treeOf(decodeURIComponent(m[1]));
      return jsonRes({
        sha: m[1],
        tree: [...map.entries()].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha, size: 1 }))
      });
    }
    if (method === 'GET' && (m = rel.match(/^\/git\/blobs\/(.+)$/))) {
      const text = blobs.get(decodeURIComponent(m[1]));
      return text === undefined
        ? jsonRes({ message: 'Not Found' }, 404)
        : jsonRes({ sha: m[1], encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
    }
    if (method === 'GET' && (m = rel.match(/^\/git\/commits\/(.+)$/))) {
      const c = commits.get(decodeURIComponent(m[1]));
      return c
        ? jsonRes({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message })
        : jsonRes({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = rel.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      return jsonRes(diff(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
    }
    if (method === 'GET' && (m = rel.match(/^\/contents\/(.+)$/))) {
      const p = decodeURIComponent(m[1]);
      const branch = (/[?&]ref=([^&]+)/.exec(u) || [])[1] || 'main';
      const sha = treeOf(refs.get(branch)).get(p);
      if (!sha) return jsonRes({ message: 'Not Found' }, 404);
      return jsonRes({ sha, encoding: 'base64', content: Buffer.from(blobs.get(sha), 'utf8').toString('base64') });
    }
    if (method === 'POST' && rel === '/git/blobs') return jsonRes({ sha: setBlob(body.content) });
    if (method === 'POST' && rel === '/git/trees') {
      const map = treeOf(body.base_tree);
      (body.tree || []).forEach((e) => {
        if (e.sha === null) map.delete(e.path);
        else map.set(e.path, e.sha);
      });
      return jsonRes({ sha: setTree(map) });
    }
    if (method === 'POST' && rel === '/git/commits') {
      return jsonRes({ sha: setCommit(body.message, body.tree, body.parents || []) });
    }
    if (method === 'POST' && rel === '/git/refs') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      if (refs.has(branch)) return jsonRes({ message: 'Reference already exists' }, 422);
      refs.set(branch, body.sha);
      return jsonRes({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (method === 'PATCH' && (m = rel.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[1]);
      if (!refs.has(branch)) return jsonRes({ message: 'Not Found' }, 404);
      refs.set(branch, body.sha);
      return jsonRes({ ref: 'refs/heads/' + branch, object: { sha: body.sha } });
    }
    if (method === 'DELETE' && (m = rel.match(/^\/git\/refs\/heads\/(.+)$/))) {
      refs.delete(decodeURIComponent(m[1]));
      return jsonRes({});
    }
    return jsonRes({ message: 'not mocked: ' + method + ' ' + rel }, 404);
  }

  return { handle, blobs, trees, commits, refs, firstCommit, treeOf };
}

{
  const dom = await boot();
  const w = dom.window;
  const d = w.document;
  const server = makeGitServer(POSTS);
  w.fetch = (url, init) => server.handle(url, init);

  const ghCard = Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent));
  ghCard.click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '进入 GitHub 列表');
  await waitFor(() => d.querySelector('#post-list li .p-title').textContent === '排序测试', '标题已填充');

  /* 打开 main 上的文章 */
  d.querySelectorAll('#post-list li')[0].click();
  await waitFor(() => d.querySelector('#body').textContent.indexOf('正文三十') !== -1, '正文渲染');
  check(!d.querySelector('#btn-edit').classList.contains('hidden'), '只读时显示「编辑」');
  check(d.querySelector('#btn-save').classList.contains('hidden'), '只读时隐藏「保存」');
  check(d.querySelector('#btn-publish').classList.contains('hidden'), '还没草稿时隐藏「发布」');

  /* 点编辑：进入可编辑态，但还没有分支 */
  d.querySelector('#btn-edit').click();
  check(d.querySelector('#btn-edit').classList.contains('hidden'), '点编辑后隐藏「编辑」');
  check(!d.querySelector('#btn-save').classList.contains('hidden'), '点编辑后显示「保存」');
  check(d.querySelector('#readonly-hint').textContent === '草稿 · 未保存', '提示「草稿 · 未保存」',
    d.querySelector('#readonly-hint').textContent);
  check(!server.refs.has('draft/aaa111'), '仅点编辑不会创建分支');

  /* 第一次保存 → 创建 draft/<abbrlink> */
  const titleInput = d.querySelector('#f-title');
  titleInput.value = '排序测试（改）';
  titleInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#btn-save').click();
  await waitFor(() => server.refs.has('draft/aaa111'), '保存后创建草稿分支');

  const head1 = server.refs.get('draft/aaa111');
  const c1 = server.commits.get(head1);
  check(c1.parents[0] === server.firstCommit, '草稿首个提交的父提交 = main HEAD', c1.parents.join(','));
  const text1 = server.blobs.get(server.treeOf(head1).get('source/_posts/30 排序测试.md'));
  check(text1.indexOf('title: 排序测试（改）') !== -1, '草稿里是改后的标题');
  check(!d.querySelector('#btn-publish').classList.contains('hidden'), '保存后出现「发布」');
  check(d.querySelector('#readonly-hint').textContent === '草稿 · draft/aaa111', '提示草稿分支名',
    d.querySelector('#readonly-hint').textContent);
  const badge = d.querySelector('#post-list li .p-badge');
  check(!!badge && badge.textContent === '草稿', '列表挂「草稿」标签');

  /* 第二次保存 → 更新同一个分支，parent 是上一次的提交 */
  const desc = d.querySelector('#f-description');
  desc.value = '第二次保存';
  desc.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#btn-save').click();
  await waitFor(() => server.refs.get('draft/aaa111') !== head1, '第二次保存更新分支');
  const head2 = server.refs.get('draft/aaa111');
  check(server.commits.get(head2).parents[0] === head1, '第二次提交基于上一次草稿', JSON.stringify(server.commits.get(head2).parents));
  check(server.refs.get('main') === server.firstCommit, '保存不影响 main');

  /* 发布 → 一次 commit 合并到 main，再删掉分支 */
  const beforePublish = [...server.commits.keys()].length;
  d.querySelector('#btn-publish').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '发布确认弹窗');
  check(d.querySelector('#modal-title').textContent === '发布到 main？', '弹窗标题',
    d.querySelector('#modal-title').textContent);
  const pubBtn = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '发布');
  check(!!pubBtn, '弹窗里有「发布」按钮');
  pubBtn.click();
  await waitFor(() => !server.refs.has('draft/aaa111') && server.refs.get('main') !== server.firstCommit, '发布完成');

  const mainHead = server.refs.get('main');
  const mc = server.commits.get(mainHead);
  check(mc.message === 'post: 排序测试（改）', 'main 提交信息', mc.message);
  check(mc.parents[0] === server.firstCommit, 'main 提交只有一个新 parent');
  const mainText = server.blobs.get(server.treeOf(mainHead).get('source/_posts/30 排序测试.md'));
  check(mainText.indexOf('title: 排序测试（改）') !== -1, 'main 上已是改后的标题');
  check(mainText.indexOf('第二次保存') !== -1, 'main 上带着第二次保存的内容');
  const posts = [...server.commits.values()].filter((c) => /^post: /.test(c.message));
  check(posts.length === 1, '一次发布只产生一个提交', String(posts.length));
  check([...server.commits.keys()].length >= beforePublish, '发布没有重写历史');

  check(d.querySelector('#readonly-hint').textContent === '只读 · main', '发布后回到只读提示',
    d.querySelector('#readonly-hint').textContent);
  check(d.querySelector('#btn-save').classList.contains('hidden'), '发布后隐藏「保存」');
  check(!d.querySelector('#btn-edit').classList.contains('hidden'), '发布后显示「编辑」');
  check(!d.querySelector('#post-list li .p-badge'), '发布后草稿标签消失');

  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

