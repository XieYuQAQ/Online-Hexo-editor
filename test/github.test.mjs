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
  check(!d.querySelector('#busy').classList.contains('hidden'), '进入 GitHub 时弹出阻塞遮罩');
  check(d.querySelector('#busy-text').textContent.length > 0, '遮罩里带提示文案',
    d.querySelector('#busy-text').textContent);

  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '列表渲染出 3 篇');
  await waitFor(() => {
    const t = d.querySelector('#post-list li .p-title');
    return t && t.textContent !== '30 排序测试';
  }, '标题被 front matter 覆盖');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '加载完成后遮罩消失');

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
function makeGitServer(posts, opts) {
  opts = opts || {};
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map();
  const blobByText = new Map();
  let seq = 0;
  const nid = (c) => c + (++seq);
  // 和真实 Git 一样按内容寻址：同样的内容必须得到同一个 sha，否则「恢复删除」永远有差异
  const setBlob = (text) => {
    if (blobByText.has(text)) return blobByText.get(text);
    const sha = nid('b');
    blobs.set(sha, text);
    blobByText.set(text, sha);
    return sha;
  };
  const setTree = (entries) => { const sha = nid('t'); trees.set(sha, new Map(entries)); return sha; };
  const setCommit = (message, tree, parents) => {
    const sha = nid('c'); commits.set(sha, { message, tree, parents }); return sha;
  };

  const seed = new Map();
  posts.forEach((p) => seed.set('source/_posts/' + p.name, setBlob(rawOf(p))));
  (opts.files || []).forEach((f) => seed.set(f.path, setBlob(f.text)));
  (opts.images || []).forEach((f) => seed.set(f.path, setBlob(f.text || 'fake-image-bytes')));
  const firstTree = setTree(seed);
  const firstCommit = setCommit('init', firstTree, []);
  refs.set('main', firstCommit);

  const resolve = (x) => refs.get(x) || x;
  const treeOf = (sha) => {
    const s = resolve(sha);
    const c = commits.get(s);
    return new Map(trees.get(c ? c.tree : s) || new Map());
  };

  function ancestors(sha) {
    const out = [];
    let cur = resolve(sha);
    while (cur && commits.has(cur)) {
      out.push(cur);
      cur = commits.get(cur).parents[0];
    }
    return out;
  }

  /** GitHub 的 compare 用三点语义：先找 merge base，再比 tree */
  function mergeBase(a, b) {
    const set = new Set(ancestors(a));
    for (const c of ancestors(b)) if (set.has(c)) return c;
    return null;
  }

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
    if (method === 'GET' && (m = rel.match(/^\/git\/matching-refs\/heads\/(.*)$/))) {
      const prefix = 'refs/heads/' + m[1];
      return jsonRes([...refs.keys()].filter((b) => ('refs/heads/' + b).startsWith(prefix))
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
      const c = commits.get(resolve(decodeURIComponent(m[1])));
      return c
        ? jsonRes({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), message: c.message })
        : jsonRes({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && (m = rel.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      const a = resolve(decodeURIComponent(m[1]));
      const b = resolve(decodeURIComponent(m[2]));
      return jsonRes(diff(mergeBase(a, b) || a, b));
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
  const calls = [];
  w.fetch = (url, init) => { calls.push(String(url)); return server.handle(url, init); };

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
  check(!d.querySelector('#busy').classList.contains('hidden'), '保存时弹出阻塞遮罩');
  check(d.querySelector('#busy-text').textContent.indexOf('保存') !== -1, '遮罩提示是保存中',
    d.querySelector('#busy-text').textContent);
  await waitFor(() => server.refs.has('draft/aaa111'), '保存后创建草稿分支');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '保存完成后遮罩消失');

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

  /* 刷新：草稿分支重新并入列表，只影响真正改动过的那一篇 */
  const blob0 = calls.filter((u) => /\/git\/blobs\//.test(u)).length;
  d.querySelector('#btn-refresh').click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '刷新后列表 3 篇');
  await waitFor(() => d.querySelector('#post-list li .p-badge'), '刷新后草稿标签重新挂上');
  await new Promise((r) => setTimeout(r, 150));
  const blob1 = calls.filter((u) => /\/git\/blobs\//.test(u)).length;
  check(blob1 - blob0 === 1, '只读了改动过的那一个文件', String(blob1 - blob0));
  const badges = d.querySelectorAll('#post-list li .p-badge');
  check(badges.length === 1, '只有一篇带草稿标签', String(badges.length));
  const draftLi = Array.from(d.querySelectorAll('#post-list li')).find((li) => li.querySelector('.p-badge'));
  const draftTitle = draftLi && draftLi.querySelector('.p-title span:last-child').textContent;
  check(!!draftLi && draftTitle === '排序测试（改）', '草稿项标题是改后的', draftTitle);

  /* 重新打开草稿：读草稿分支，不是 main */
  draftLi.click();
  await waitFor(() => d.querySelector('#f-description').value === '第二次保存', '打开草稿读到草稿内容');
  check(d.querySelector('#readonly-hint').textContent === '草稿 · draft/aaa111', '打开草稿提示分支',
    d.querySelector('#readonly-hint').textContent);
  check(!d.querySelector('#btn-publish').classList.contains('hidden'), '打开草稿就有「发布」');

  /* 发布 → 一次 commit 合并到 main，再删掉分支 */
  const beforePublish = [...server.commits.keys()].length;
  d.querySelector('#btn-publish').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '发布确认弹窗');
  check(d.querySelector('#modal-title').textContent === '发布到网站', '弹窗标题',
    d.querySelector('#modal-title').textContent);
  const modalText = d.querySelector('#modal-body').textContent;
  check(modalText.indexOf('草稿分支 draft/aaa111') !== -1, '弹窗写明草稿分支', modalText);
  check(modalText.indexOf('Netlify 将开始构建') !== -1, '弹窗提示 Netlify 构建', modalText);
  const pubBtn = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '发布');
  check(!!pubBtn, '弹窗里有「发布」按钮');
  const busyEl = d.querySelector('#busy');
  let sawPublishBusy = false;
  const obs = new w.MutationObserver(() => {
    if (!busyEl.classList.contains('hidden') && /发布/.test(d.querySelector('#busy-text').textContent)) {
      sawPublishBusy = true;
    }
  });
  obs.observe(busyEl, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true, characterData: true });
  pubBtn.click();
  await waitFor(() => !server.refs.has('draft/aaa111') && server.refs.get('main') !== server.firstCommit, '发布完成');
  obs.disconnect();
  check(sawPublishBusy, '发布时弹出阻塞遮罩');
  await waitFor(() => busyEl.classList.contains('hidden'), '发布完成后遮罩消失');

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

/* ---------------- 4. 两篇草稿一起发布：只产生一次 main 提交 ---------------- */
{
  const dom = await boot();
  const w = dom.window;
  const d = w.document;
  const server = makeGitServer(POSTS);
  w.fetch = (url, init) => server.handle(url, init);

  const titleOf = (li) => li.querySelector('.p-title span:last-child').textContent;
  const clickPost = (title) => {
    const li = Array.from(d.querySelectorAll('#post-list li')).find((x) => titleOf(x) === title);
    if (!li) throw new Error('找不到列表项：' + title);
    li.click();
  };

  Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent)).click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '进入列表');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '列表加载完成');

  /* 第一篇：编辑 → 保存草稿 */
  clickPost('排序测试');
  await waitFor(() => d.querySelector('#f-title').value === '排序测试', '打开第一篇');
  d.querySelector('#btn-edit').click();
  let input = d.querySelector('#f-title');
  input.value = '排序测试（批量）';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#btn-save').click();
  await waitFor(() => server.refs.has('draft/aaa111'), '第一篇生成草稿');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '第一篇保存完成');

  /* 第二篇：编辑 → 保存草稿 */
  clickPost('中间一篇');
  await waitFor(() => d.querySelector('#f-title').value === '中间一篇', '打开第二篇');
  d.querySelector('#btn-edit').click();
  input = d.querySelector('#f-title');
  input.value = '中间一篇（批量）';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#btn-save').click();
  await waitFor(() => server.refs.has('draft/bbb222'), '第二篇生成草稿');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '第二篇保存完成');

  /* 草稿栏与勾选 */
  const bar = d.querySelector('#draft-bar');
  check(!bar.classList.contains('hidden'), '有草稿时出现批量发布栏');
  check(/草稿 2 篇/.test(d.querySelector('#draft-bar-info').textContent), '草稿栏显示 2 篇',
    d.querySelector('#draft-bar-info').textContent);
  check(d.querySelectorAll('#post-list .p-check').length === 2, '两条草稿都有勾选框');
  check(d.querySelector('#btn-publish-selected').disabled === true, '没选时按钮禁用');

  d.querySelector('#btn-select-all').click();
  check(d.querySelector('#btn-publish-selected').textContent === '发布选中 (2)', '全选后按钮显示数量',
    d.querySelector('#btn-publish-selected').textContent);
  check(d.querySelector('#btn-publish-selected').disabled === false, '全选后按钮可用');

  /* 批量发布确认框 */
  d.querySelector('#btn-publish-selected').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '批量发布弹窗');
  check(d.querySelector('#modal-title').textContent === '发布到网站', '弹窗标题', d.querySelector('#modal-title').textContent);
  const bodyText = d.querySelector('#modal-body').textContent;
  check(bodyText.indexOf('2 个草稿分支') !== -1, '说明合并几个分支', bodyText);
  check(d.querySelectorAll('#modal-body .pub-list li').length === 2, '列出两篇标题',
    String(d.querySelectorAll('#modal-body .pub-list li').length));

  const go = Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => /^发布 2 篇/.test(b.textContent));
  check(!!go, '确认按钮带数量');
  go.click();
  await waitFor(() => !server.refs.has('draft/aaa111') && !server.refs.has('draft/bbb222'), '两条草稿分支都被删除');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '批量发布完成');

  /* main 只前进一次，两个文件都在 */
  const mainHead = server.refs.get('main');
  const mc = server.commits.get(mainHead);
  check(mc.parents[0] === server.firstCommit, 'main 只前进一个提交', mc.parents.join(','));
  check(/^post: 发布 2 篇/.test(mc.message), '提交信息包含篇数', mc.message);
  const tree = server.treeOf(mainHead);
  check((server.blobs.get(tree.get('source/_posts/30 排序测试.md')) || '').indexOf('排序测试（批量）') !== -1,
    '第一篇内容进 main');
  check((server.blobs.get(tree.get('source/_posts/28 中间一篇.md')) || '').indexOf('中间一篇（批量）') !== -1,
    '第二篇内容进 main');
  const publishCommits = [...server.commits.values()].filter((c) => c.parents[0] === server.firstCommit && /^post: /.test(c.message));
  check(publishCommits.length === 1, '两篇一起发布只产生一个提交', String(publishCommits.length));

  check(d.querySelectorAll('#post-list .p-badge').length === 0, '发布后没有草稿标签');
  check(bar.classList.contains('hidden'), '发布后草稿栏消失');

  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

/* ---------------- 5. 删除文章：待删除 → 撤销 → 再删除 → 发布生效 ---------------- */
{
  const dom = await boot();
  const w = dom.window;
  const d = w.document;
  const server = makeGitServer(POSTS);
  w.fetch = (url, init) => server.handle(url, init);
  const PATH = 'source/_posts/30 排序测试.md';

  const modalBtn = (text) => Array.from(d.querySelectorAll('#modal-foot .btn'))
    .find((b) => b.textContent === text);

  Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent)).click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '进入列表');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '列表加载完成');

  d.querySelectorAll('#post-list li')[0].click();
  await waitFor(() => d.querySelector('#f-title').value === '排序测试', '打开文章');
  check(!d.querySelector('#btn-delete').classList.contains('hidden'), 'GitHub 模式下有「删除」');

  /* 第一次删除：标记为待删除 */
  d.querySelector('#btn-delete').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '删除确认弹窗');
  check(d.querySelector('#modal-title').textContent === '删除文章', '弹窗标题', d.querySelector('#modal-title').textContent);
  modalBtn('删除').click();
  await waitFor(() => server.refs.has('draft/aaa111'), '建立待删除草稿分支');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '删除标记完成');

  const delHead = server.refs.get('draft/aaa111');
  check(!server.treeOf(delHead).has(PATH), '草稿分支里文件已删除');
  check(server.treeOf(server.refs.get('main')).has(PATH), 'main 上的文件还在（发布后才消失）');
  check(d.querySelector('#readonly-hint').textContent === '待删除 · draft/aaa111', '提示待删除',
    d.querySelector('#readonly-hint').textContent);
  check(!d.querySelector('#btn-undo-delete').classList.contains('hidden'), '出现「撤销删除」');
  check(d.querySelector('#btn-delete').classList.contains('hidden'), '待删除时隐藏「删除」');
  check(!!d.querySelector('#post-list li .p-badge-del'), '列表显示「待删除」标签');
  check(d.querySelector('#post-list li .p-badge-del').textContent === '待删除', '标签文字');

  /* 撤销 */
  d.querySelector('#btn-undo-delete').click();
  await waitFor(() => !server.refs.has('draft/aaa111'), '撤销后分支被删掉');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '撤销完成');
  check(!d.querySelector('#post-list .p-badge-del'), '撤销后没有待删除标签');
  check(!d.querySelector('#btn-edit').classList.contains('hidden'), '撤销后回到可编辑入口');
  check(d.querySelector('#readonly-hint').textContent === '只读 · main', '撤销后提示回到只读');

  /* 再删除一次，然后发布 */
  d.querySelector('#btn-delete').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '再次删除确认');
  modalBtn('删除').click();
  await waitFor(() => server.refs.has('draft/aaa111'), '再次建立待删除分支');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '标记完成');
  const before = server.refs.get('main');

  d.querySelector('#btn-publish').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '发布确认');
  modalBtn('发布').click();
  await waitFor(() => server.refs.get('main') !== before, '发布完成');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '发布遮罩消失');

  check(!server.treeOf(server.refs.get('main')).has(PATH), '发布后 main 上文件已删除');
  check(server.commits.get(server.refs.get('main')).message === 'post: 排序测试',
    '提交信息', server.commits.get(server.refs.get('main')).message);
  check(!server.refs.has('draft/aaa111'), '发布后草稿分支被删除');
  await waitFor(() => d.querySelectorAll('#post-list li').length === 2, '列表剩下 2 篇');
  check(!d.querySelector('#post-list .p-badge-del'), '发布后没有待删除标签');

  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

/* ---------------- 6. 图片管理：引用检查 / 待删除队列 / 随发布生效 ---------------- */
{
  const IMG_USED = 'source/images/2026/10/TO6Gf9&ASSC@yAY1.jpg';
  const IMG_ORPHAN = 'source/images/2026/10/bbbb222222.jpg';
  const posts = POSTS.map((p, i) => (i === 0
    ? { ...p, body: p.body + '\n\n![](/images/2026/10/TO6Gf9&ASSC@yAY1.jpg)' }
    : p));

  const dom = await boot();
  const w = dom.window, d = w.document;
  const server = makeGitServer(posts, { images: [{ path: IMG_USED }, { path: IMG_ORPHAN }] });
  w.fetch = (url, init) => server.handle(url, init);

  Array.from(d.querySelectorAll('.ws-card')).find((b) => /GitHub/.test(b.textContent)).click();
  await waitFor(() => d.querySelectorAll('#post-list li').length === 3, '进入列表');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '列表加载完成');
  check(!d.querySelector('#btn-images').classList.contains('hidden'), 'GitHub 模式显示图片入口');

  /* 打开图片管理：两张图，引用数分别为 1 / 0 */
  d.querySelector('#btn-images').click();
  await waitFor(() => d.querySelector('#modal-title').textContent === '图片管理', '图片管理弹窗');
  await waitFor(() => d.querySelectorAll('.img-row').length === 2, '列出两张图片');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '引用扫描完成');

  const rowOf = (base) => Array.from(d.querySelectorAll('.img-row'))
    .find((r) => r.querySelector('.img-name').textContent.indexOf(base) !== -1);
  const used = rowOf('to6gf9&assc@yay1.jpg');
  const orphan = rowOf('bbbb222222.jpg');
  check(!!used && !!orphan, '两张图片都在列表里');
  check(used.querySelector('.img-meta').textContent.indexOf('引用 1') !== -1, '被引用图片计数 1',
    used.querySelector('.img-meta').textContent);
  check(orphan.querySelector('.img-meta').textContent.indexOf('引用 0') !== -1, '孤儿图计数 0',
    orphan.querySelector('.img-meta').textContent);

  /* 被引用的图片不能删：行内展开引用，不弹新窗 */
  used.querySelector('.img-actions .btn.danger').click();
  await waitFor(() => used.querySelector('.img-refs'), '行内展开引用列表');
  check(used.querySelector('.img-refs').textContent.indexOf('source/_posts/30 排序测试.md') !== -1,
    '列出引用它的文章', used.querySelector('.img-refs').textContent);
  check(!rowOf('to6gf9&assc@yay1.jpg').querySelector('.img-badge'), '被引用时不会进待删除');

  /* 孤儿图加入待删除 */
  orphan.querySelector('.img-actions .btn.danger').click();
  await waitFor(() => rowOf('bbbb222222.jpg').querySelector('.img-badge'), '孤儿图标记待删除');
  check(d.querySelector('.img-foot').textContent.indexOf('待删除 1 张') !== -1, '底部汇总待删除数量',
    d.querySelector('.img-foot').textContent);

  d.querySelector('#modal-close').click();
  await waitFor(() => d.querySelector('#modal').classList.contains('hidden'), '关闭图片管理');

  /* 建一篇草稿并发布，队列里的图片随这次发布一起删掉 */
  d.querySelectorAll('#post-list li')[0].click();
  await waitFor(() => d.querySelector('#f-title').value === '排序测试', '打开文章');
  d.querySelector('#btn-edit').click();
  const input = d.querySelector('#f-title');
  input.value = '排序测试（图片测试）';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#btn-save').click();
  await waitFor(() => server.refs.has('draft/aaa111'), '保存草稿');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '保存完成');

  d.querySelector('#btn-publish').click();
  await waitFor(() => !d.querySelector('#modal').classList.contains('hidden'), '发布确认');
  Array.from(d.querySelectorAll('#modal-foot .btn')).find((b) => b.textContent === '发布').click();
  await waitFor(() => !server.refs.has('draft/aaa111'), '发布完成');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '发布遮罩消失');

  const mainTree = server.treeOf(server.refs.get('main'));
  check(!mainTree.has(IMG_ORPHAN), '孤儿图已从 main 删除');
  check(mainTree.has(IMG_USED), '被引用的图片保留');
  check(server.commits.get(server.refs.get('main')).message.indexOf('图片删除') !== -1,
    '提交信息标注图片删除', server.commits.get(server.refs.get('main')).message);
  check(JSON.parse(w.localStorage.getItem('hexo-editor:imgQueue:' + REPO) || '[]').length === 0,
    '待删除队列已清空');

  /* 重新打开：只剩一张 */
  d.querySelector('#btn-images').click();
  await waitFor(() => d.querySelectorAll('.img-row').length === 1, '重开只剩一张图');
  await waitFor(() => d.querySelector('#busy').classList.contains('hidden'), '重扫完成');
  check(d.querySelector('.img-row .img-name').textContent.indexOf('to6gf9&assc@yay1.jpg') !== -1,
    '留下的是被引用那张', d.querySelector('.img-row .img-name').textContent);

  console.log(`[github] ${checks - failed}/${checks} 通过`);
  if (failed) process.exitCode = 1;
}

