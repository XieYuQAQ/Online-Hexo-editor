/*!
 * Hexo 文章编辑器 · 主程序
 * 依赖：core.js（格式层）
 * 无后端、无构建、无依赖：浏览器直接打开 index.html 即可（双击就行）
 */
(function () {
  'use strict';

  var Core = window.HexoCore;

  /* ================================================================
   * 0. 小工具
   * ================================================================ */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, kind === 'err' ? 4200 : 2400);
  }

  /* 阻塞式加载提示：铺满全屏 + 遮罩，等待期间不接受任何点击 */
  var busyDepth = 0;
  function showBusy(text) {
    busyDepth += 1;
    var box = $('#busy');
    if (!box) return;
    $('#busy-text').textContent = text || '处理中…';
    box.classList.remove('hidden');
    document.body.classList.add('busy-lock');
  }

  function setBusyText(text) {
    var box = $('#busy');
    if (!box || box.classList.contains('hidden')) return;
    $('#busy-text').textContent = text;
  }

  function hideBusy() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth > 0) return;
    var box = $('#busy');
    if (box) box.classList.add('hidden');
    document.body.classList.remove('busy-lock');
  }

  function isBusy() {
    var box = $('#busy');
    return !!box && !box.classList.contains('hidden');
  }

  function debounce(fn, wait) {
    var h = null;
    var run = function () {
      var args = arguments, self = this;
      clearTimeout(h);
      h = setTimeout(function () { fn.apply(self, args); }, wait);
    };
    run.cancel = function () { clearTimeout(h); h = null; };
    return run;
  }

  /** 简单确认 / 表单弹窗 */
  function openModal(opts) {
    return new Promise(function (resolve) {
      var modal = $('#modal');
      $('#modal-title').textContent = opts.title || '';
      var body = $('#modal-body');
      body.innerHTML = '';
      if (typeof opts.body === 'string') body.innerHTML = opts.body;
      else if (opts.body) body.appendChild(opts.body);

      var foot = $('#modal-foot');
      foot.innerHTML = '';
      var closed = false;
      function close(val) {
        if (closed) return;
        closed = true;
        modal.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && opts.enterConfirm !== false) {
          var primary = foot.querySelector('.btn.primary');
          if (primary) { e.preventDefault(); primary.click(); }
        }
      }
      (opts.actions || [{ label: '关闭', primary: true, value: true }]).forEach(function (a) {
        foot.appendChild(el('button', {
          class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
          text: a.label,
          onclick: function () {
            if (a.onClick) {
              var r = a.onClick(body, close);
              if (r === false) return;
            }
            close(a.value === undefined ? true : a.value);
          }
        }));
      });
      $('#modal-close').onclick = function () { close(null); };
      modal.classList.remove('hidden');
      document.addEventListener('keydown', onKey);
      setTimeout(function () {
        var first = body.querySelector('input, textarea, select');
        if (first) first.focus();
      }, 30);
    });
  }

  function promptText(title, label, value, placeholder) {
    var wrap = el('label', { class: 'field' }, [
      el('span', { class: 'lbl', text: label }),
      el('input', { type: 'text', value: value || '', placeholder: placeholder || '' })
    ]);
    var input = wrap.querySelector('input');
    return openModal({
      title: title,
      body: wrap,
      actions: [
        { label: '取消', value: null },
        { label: '确定', primary: true, onClick: function () { return input.value.trim() !== '' || true; }, value: 'ok' }
      ]
    }).then(function (r) { return r === 'ok' ? input.value.trim() : null; });
  }

  function downloadBlob(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  /* ================================================================
   * 1. IndexedDB（记住上次打开的目录）
   * ================================================================ */
  var idb = (function () {
    var DB = 'hexo-editor', STORE = 'handles';
    function open() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return {
      get: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve) {
            var tx = db.transaction(STORE, 'readonly');
            var r = tx.objectStore(STORE).get(key);
            r.onsuccess = function () { resolve(r.result || null); };
            r.onerror = function () { resolve(null); };
          });
        }).catch(function () { return null; });
      },
      set: function (key, val) {
        return open().then(function (db) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(val, key);
        }).catch(function () {});
      },
      del: function (key) {
        return open().then(function (db) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
        }).catch(function () {});
      }
    };
  })();

  /* ================================================================
   * 2. 状态
   * ================================================================ */
  var state = {
    mode: 'github',         // 只有 GitHub 模式；未连上时保持 demo 占位
    readOnly: false,        // GitHub 模式下打开 main 上的文章时为 true
    githubRepo: '',
    projectId: 'demo',
    sidebarCollapsed: false,// 打开文章后侧栏是否收起
    posts: [],              // { id, path, name, doc, raw, handle, dirty, savedOnce }
    selected: new Set(),    // GitHub 模式里勾选的草稿分支名
    current: null,
    imageIndex: null,       // 全局图片索引 { key, main: {path:sha}, drafts: {path:sha} }
    filter: { q: '', tags: [], dirtyOnly: false, sort: 'date-desc' },
    imgSize: new Map()      // path -> { w, h }：上次加载后的实际渲染尺寸，重建时用来占位，避免图片重新加载时高度塌陷
  };


  function uid() { return Math.random().toString(36).slice(2, 10); }

  /**
   * 图片文件名：10 位随机「数字+小写字母」组合，后缀沿用原文件的
   * （站内 167 处图片都是这种无意义短名，避免中文/空格/重名问题）
   */
  var IMG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randomImageName(ext) {
    var s = '';
    for (var i = 0; i < 10; i++) s += IMG_CHARS.charAt(Math.floor(Math.random() * IMG_CHARS.length));
    return s + (ext || '');
  }

  /** 取原文件的扩展名（含点），取不到就用 .jpg */
  function fileExt(name) {
    var m = /\.[A-Za-z0-9]+$/.exec(String(name || ''));
    return m ? m[0] : '.jpg';
  }

  var projectHandles = new WeakMap();
  async function identifyProject(handle) {
    if (projectHandles.has(handle)) return projectHandles.get(handle);
    var projects = await idb.get('projects') || [];
    for (var i = 0; i < projects.length; i++) {
      try {
        if (handle === projects[i].handle || (handle.isSameEntry && await handle.isSameEntry(projects[i].handle))) {
          projectHandles.set(handle, projects[i].id);
          return projects[i].id;
        }
      } catch (e) { /* 失效句柄不能作为其他目录的身份 */ }
    }
    var id = uid() + '-' + Date.now().toString(36);
    projects.push({ id: id, handle: handle });
    await idb.set('projects', projects);
    projectHandles.set(handle, id);
    return id;
  }



  function pathParts(path) {
    var parts = String(path || '').split('/');
    if (!parts.length || parts.some(function (p) { return !p || p === '.' || p === '..' || /[\\\u0000-\u001f]/.test(p); })) {
      throw new Error('文章路径不合法');
    }
    return parts;
  }



  /* ================================================================
   * 4. 列表
   * ================================================================ */
  function reindex() {
    var tags = new Map();
    state.posts.forEach(function (p) {
      var t = Core.get(p.doc, 'tags');
      (Array.isArray(t) ? t : []).forEach(function (x) {
        tags.set(x, (tags.get(x) || 0) + 1);
      });
    });
    state.allTags = tags;
    renderTagFilter();
    renderList();
  }

  function renderTagFilter() {
    var box = $('#tag-filter');
    box.innerHTML = '';
    var entries = Array.from(state.allTags.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    entries.forEach(function (pair) {
      var tag = pair[0];
      var b = el('button', {
        class: 'tagbtn' + (state.filter.tags.indexOf(tag) !== -1 ? ' on' : ''),
        text: tag + ' ' + pair[1],
        onclick: function () {
          var i = state.filter.tags.indexOf(tag);
          if (i === -1) state.filter.tags.push(tag);
          else state.filter.tags.splice(i, 1);
          renderTagFilter();
          renderList();
        }
      });
      box.appendChild(b);
    });
  }

  function postTitle(p) {
    var t = String(Core.get(p.doc, 'title') || '').trim();
    return t || p.name.replace(/\.md$/i, '');
  }

  function matches(p) {
    var f = state.filter;
    if (f.dirtyOnly && !p.dirty) return false;
    if (f.tags.length) {
      var tags = Core.get(p.doc, 'tags') || [];
      for (var i = 0; i < f.tags.length; i++) if (tags.indexOf(f.tags[i]) === -1) return false;
    }
    if (f.q) {
      var q = f.q.toLowerCase();
      var hay = (postTitle(p) + ' ' + p.name + ' ' + (Core.get(p.doc, 'tags') || []).join(' ')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function sortedPosts() {
    var arr = state.posts.filter(matches);
    var s = state.filter.sort;
    arr.sort(function (a, b) {
      if (s === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      var da = Core.parseDate(Core.get(a.doc, 'date'));
      var db = Core.parseDate(Core.get(b.doc, 'date'));
      var ta = da ? da.getTime() : 0;
      var tb = db ? db.getTime() : 0;
      return s === 'date-asc' ? ta - tb : tb - ta;
    });
    return arr;
  }

  function renderList() {
    var list = $('#post-list');
    list.innerHTML = '';
    var posts = sortedPosts();
    posts.forEach(function (p) {
      var date = String(Core.get(p.doc, 'date') || '').slice(0, 10);
      var tags = Core.get(p.doc, 'tags') || [];
      var titleKids = [];
      if (p.draft) {
        var check = el('input', {
          type: 'checkbox',
          class: 'p-check',
          title: '选中以批量发布',
          onclick: function (e) {
            e.stopPropagation();
            toggleDraftSelect(p.draft.branch, this.checked);
          }
        });
        check.checked = state.selected.has(p.draft.branch);
        titleKids.push(check);
        titleKids.push(p.removed
          ? el('span', { class: 'p-badge p-badge-del', text: '待删除' })
          : el('span', { class: 'p-badge', text: '草稿' }));
      }
      titleKids.push(el('span', { text: postTitle(p) }));
      var li = el('li', {
        class: (state.current && state.current.id === p.id ? 'active ' : '') + (p.dirty ? 'dirty' : ''),
        onclick: function () { openPostFromList(p); }
      }, [
        el('div', { class: 'p-title' }, titleKids),
        el('div', { class: 'p-meta' }, [
          el('span', { text: date || '无日期' }),
          el('span', { class: 'p-tags', text: tags.slice(0, 3).join(' / ') })
        ])
      ]);
      list.appendChild(li);
    });
    $('#count-info').textContent = posts.length + ' / ' + state.posts.length + ' 篇';
    if (!posts.length) {
      list.appendChild(el('li', { class: 'p-empty', text: '没有匹配的文章' }));
    }
    renderDraftBar();
  }

  /* 草稿多选：只影响批量发布，不影响打开文章 */
  function draftPosts() {
    return state.posts.filter(function (p) { return !!p.draft; });
  }

  function renderDraftBar() {
    var bar = $('#draft-bar');
    if (!bar) return;
    var drafts = state.mode === 'github' ? draftPosts() : [];
    bar.classList.toggle('hidden', !drafts.length);
    // 清掉已经发布/不存在的选择
    Array.from(state.selected).forEach(function (b) {
      if (!drafts.some(function (p) { return p.draft.branch === b; })) state.selected.delete(b);
    });
    if (!drafts.length) { state.selected.clear(); return; }

    var n = state.selected.size;
    $('#draft-bar-info').textContent = '草稿 ' + drafts.length + ' 篇' + (n ? ' · 已选 ' + n : '');
    var pub = $('#btn-publish-selected');
    pub.disabled = n === 0;
    pub.textContent = n ? '发布选中 (' + n + ')' : '发布选中';
    $('#btn-select-all').textContent = n === drafts.length ? '取消全选' : '全选';
  }

  function toggleDraftSelect(branch, on) {
    if (on) state.selected.add(branch);
    else state.selected.delete(branch);
    renderDraftBar();
  }

  function toggleSelectAll() {
    var drafts = draftPosts();
    if (!drafts.length) return;
    if (state.selected.size === drafts.length) state.selected.clear();
    else drafts.forEach(function (p) { state.selected.add(p.draft.branch); });
    renderList();
  }

  /* ================================================================
   * 5. 编辑器：打开 / 关闭
   * ================================================================ */
  var form = {};
  var suppress = false;

  function cacheForm() {
    ['title', 'abbrlink', 'description', 'date', 'cover'].forEach(function (k) {
      form[k] = $('#f-' + k);
    });
    form.tagsInput = $('#f-tags-input');
    form.tagsChips = $('#tags-chips');
    form.fileName = $('#file-name');
    form.body = $('#body');
    bodyEl = form.body;
  }

  function closeEditor() {
    commitCurrentDraft();
    scheduleHistory.cancel();
    state.current = null;
    state.sidebarCollapsed = false;
    renderList();
    refreshMainView();
  }

  function openPost(p, opts) {
    opts = opts || {};
    if (!opts.skipDraftCommit) commitCurrentDraft();
    scheduleHistory.cancel();
    state.current = p;
    $('.ed-body').classList.remove('mobile-props');
    $('#btn-mobile-props').setAttribute('aria-expanded','false');
    $('#btn-mobile-props').textContent = '属性';
    suppress = true;
    $('#empty').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    form.fileName.value = p.pendingName || p.name;
    form.title.value = String(Core.get(p.doc, 'title') || '');
    form.abbrlink.value = String(Core.get(p.doc, 'abbrlink') || '');
    form.description.value = String(Core.get(p.doc, 'description') || '');
    form.date.value = String(Core.get(p.doc, 'date') || '');
    form.cover.value = String(Core.get(p.doc, 'cover') || '');
    renderBody(p.doc.body);
    renderChips();
    applyLocks();
    updateCoverPreview();
    if (opts.keepDirty) p.dirty = true;
    updateDirtyUI();
    updateStats();
    updateCursor();
    renderFrontMatter();
    validateAndShow();
    suppress = false;
    renderList();
    if (!opts.skipDraftCheck) checkDraft(p);
    // 打开文章后侧栏自动收起，把宽度让给编辑区
    state.sidebarCollapsed = true;
    refreshMainView();
    bodyEl.focus();
    setCaret(0);
    syncActiveLine();
    hist = []; histIdx = -1; pushHistory();
    applyReadOnly();
  }

  /** GitHub 模式下打开文章：草稿读对应分支，已发布读 main，再走原有 openPost */
  function openPostFromList(p) {
    if (!p) return;
    if (!p.github || p.loaded) { openPost(p); return; }
    var branch = (p.draft && !p.removed) ? p.draft.branch : 'main';
    toast('正在读取 ' + p.name + '…');
    GitHubStore.readPost(p.path, branch).then(function (data) {
      p.raw = data.text;
      p.doc = Core.parsePost(data.text);
      p.sha = data.sha;
      p.loaded = true;
      p.readOnly = !p.draft || p.removed;
      rememberMeta(p, p.doc);
      openPost(p, { skipDraftCheck: true });
      reindex();
    }).catch(function (e) {
      toast('读取失败：' + e.message, 'err');
    });
  }

  /** GitHub 模式的分支状态 → 表单可编辑性 + 按钮组 */
  function applyReadOnly() {
    var p = state.current;
    var isGH = state.mode === 'github';
    var ro = isGH && !!p && !!p.readOnly;
    state.readOnly = ro;
    ['title', 'description', 'cover', 'tagsInput', 'fileName'].forEach(function (k) {
      if (form[k]) form[k].disabled = ro;
    });
    if (ro) {
      if (form.abbrlink) form.abbrlink.disabled = true;
      if (form.date) form.date.disabled = true;
    }
    if (bodyEl) bodyEl.setAttribute('contenteditable', ro ? 'false' : 'true');

    function show(id, on) {
      var b = document.getElementById(id);
      if (b) b.classList.toggle('hidden', !on);
    }
    if (isGH) {
      var removed = !!p && !!p.removed;
      show('btn-edit', !!p && ro && !removed);
      show('btn-save', !!p && !ro && !removed);
      show('btn-publish', !!p && !!p.draft && (!ro || removed));
      show('btn-undo-delete', removed);
      show('btn-delete', !!p && !removed);
    } else {
      show('btn-edit', false);
      show('btn-publish', false);
      show('btn-undo-delete', false);
      show('btn-save', true);
      show('btn-delete', true);
    }

    var hint = document.getElementById('readonly-hint');
    if (hint) {
      var text = '';
      if (isGH && p) {
        if (p.removed) text = '待删除 · ' + (p.draft ? p.draft.branch : '');
        else if (ro) text = '只读 · main';
        else if (p.draft) text = '草稿 · ' + p.draft.branch;
        else text = '草稿 · 未保存';
      }
      hint.classList.toggle('hidden', !text);
      if (text) hint.textContent = text;
    }
  }

  /** 点「编辑」：把 main 上的只读文章转成可编辑草稿（此时还没建分支） */
  function enterDraftMode() {
    var p = state.current;
    if (!p || state.mode !== 'github' || !p.readOnly) return;
    p.readOnly = false;
    p.editing = true;
    applyLocks();
    applyReadOnly();
    updateDirtyUI();
    bodyEl.focus();
    toast('可编辑了。保存后写入草稿分支 draft/' +
      (String(Core.get(p.doc, 'abbrlink') || '').trim() || '…'), 'ok');
  }

  /* ---- GitHub 列表元信息（标题/日期/标签）缓存 ---- */
  var GH_META_FIELDS = ['title', 'date', 'tags', 'abbrlink', 'description', 'cover'];
  var ghCache = null;       // { entries: { path: { sha, meta } } }
  var ghCacheTimer = 0;

  function ghCacheId() {
    return 'ghPosts:' + (state.githubRepo || (window.GitHubStore && GitHubStore.repo) || 'default');
  }

  /** 从已解析的 doc 里抽列表要用的字段 */
  function metaOf(doc) {
    var meta = {};
    GH_META_FIELDS.forEach(function (k) {
      var v = Core.get(doc, k);
      meta[k] = Array.isArray(v) ? v.slice() : (v == null ? '' : v);
    });
    return meta;
  }

  /** 只有 front matter 的轻量 doc：列表先用它渲染，正文等打开时再拉 */
  function docFromMeta(meta) {
    var doc = Core.parsePost('');
    GH_META_FIELDS.forEach(function (k) {
      Core.set(doc, k, k === 'tags' ? (meta.tags || []) : String(meta[k] == null ? '' : meta[k]));
    });
    doc.body = '';
    return doc;
  }

  async function loadGhCache() {
    if (ghCache) return ghCache;
    var saved = await idb.get(ghCacheId());
    ghCache = (saved && saved.entries && typeof saved.entries === 'object') ? saved : { entries: {} };
    return ghCache;
  }

  function saveGhCacheSoon(cache) {
    clearTimeout(ghCacheTimer);
    ghCacheTimer = setTimeout(function () {
      idb.set(ghCacheId(), { entries: cache.entries, at: Date.now() });
    }, 600);
  }

  /** 丢掉已不在列表里的缓存项（文章改名/删除） */
  function pruneGhCache(cache, posts) {
    var alive = Object.create(null);
    posts.forEach(function (p) { alive[p.path] = true; });
    Object.keys(cache.entries).forEach(function (key) {
      if (!alive[key]) delete cache.entries[key];
    });
  }

  function rememberMeta(p, doc) {
    p.meta = metaOf(doc);
    if (ghCache) {
      ghCache.entries[p.path] = { sha: p.sha, meta: p.meta };
      saveGhCacheSoon(ghCache);
    }
  }

  /** 后台补齐没有缓存的文章：并发读 blob，边读边刷新列表 */
  async function fillGitHubMeta(items) {
    if (!items.length) return { done: 0, failed: 0 };
    var total = items.length;
    var done = 0;
    var last = 0;
    setBusyText('正在读取文章信息…');
    var res = await GitHubStore.readBlobs(items, function (item, text) {
      var p = item.post;
      if (p.loaded) { rememberMeta(p, p.doc); return; }
      var doc = Core.parsePost(text);
      p.raw = text;
      p.doc = doc;
      p.loaded = true;
      p.readOnly = true;
      rememberMeta(p, doc);
      done += 1;
      if (done === total || done % 3 === 0) {
        setBusyText('正在读取文章信息 ' + done + ' / ' + total);
      }
      var now = Date.now();
      if (now - last > 200) { last = now; renderList(); }
    }, { concurrency: 6 });
    if (ghCache) { pruneGhCache(ghCache, state.posts); saveGhCacheSoon(ghCache); }
    reindex();
    return res;
  }

  /** 载入 GitHub 上的文章列表：先渲染，再补齐元信息与草稿分支 */
  async function loadGitHubPosts() {
    setBusyText('正在读取文章列表…');
    var list = await GitHubStore.listPosts('main');
    var cache = await loadGhCache();
    var missing = [];
    state.posts = list.map(function (it) {
      var hit = cache.entries[it.path];
      var p = {
        id: uid(),
        path: it.path,
        name: it.name,
        doc: Core.parsePost(''),
        raw: '',
        sha: it.sha,
        dirty: false,
        savedOnce: true,
        github: true,
        readOnly: true,
        loaded: false,
        mainExists: true
      };
      if (hit && hit.sha === it.sha && hit.meta) {
        p.doc = docFromMeta(hit.meta);
        p.meta = hit.meta;
      } else {
        missing.push({ sha: it.sha, post: p });
      }
      return p;
    });
    state.current = null;
    reindex();
    refreshMainView();
    var res = await fillGitHubMeta(missing);
    if (res.failed) toast('有 ' + res.failed + ' 篇读取失败，已跳过', 'err');
    setBusyText('正在合并草稿分支…');
    await mergeDraftBranches();
    return { total: state.posts.length, cached: state.posts.length - missing.length };
  }

  async function enterGitHub() {
    if (!window.GitHubStore) { toast('GitHub 模块未加载', 'err'); return; }
    showBusy('正在连接 GitHub…');
    try {
      var st = await GitHubStore.status();
      if (!st.ok) {
        if (st.error === 401) { GitHubStore.login(); return; }
        toast('连接失败：' + (st.message || ('HTTP ' + st.error)), 'err');
        return;
      }
      state.mode = 'github';
      state.githubRepo = st.repo;
      ghCache = null;
      var info = await loadGitHubPosts();
      updateModeUI();
      toast('已连接 ' + st.repo + '，共 ' + info.total + ' 篇' +
        (info.cached ? '（' + info.cached + ' 篇来自缓存）' : ''), 'ok');
    } catch (e) {
      state.mode = 'demo';
      updateModeUI();
      toast('读取列表失败：' + e.message, 'err');
    } finally {
      hideBusy();
    }
  }

  /* ---------------- 授权回调结果 / 登录过期 ---------------- */

  // 回调失败时 github-auth-callback.js 会带 ?auth=error&reason=...
  var AUTH_REASON_TEXT = {
    access_denied: '你在 GitHub 页面上拒绝了授权。',
    no_code: 'GitHub 没有返回授权码，可能是授权被取消、页面停留过久，或回调地址不一致。',
    state_mismatch: '登录校验失败（state 不匹配）。可能是授权页停留太久，或 Cookie 被清理，重试一次即可。',
    exchange_failed: '服务端用授权码换取 token 失败，通常是网络问题或 GitHub App 配置有误。',
    no_token: 'GitHub 没有返回 access token，请确认 GitHub App 的权限配置。',
    app_not_configured: '服务端没有配置 GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET。',
    token_secret_missing: '服务端没有配置 GITHUB_TOKEN_SECRET（用于加密 Cookie）。',
    unknown: '授权没有完成，原因未知。'
  };

  /** 读 URL 上的授权失败标记；没有则返回空串 */
  function readAuthError() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('auth') !== 'error') return '';
      return q.get('reason') || 'unknown';
    } catch (e) {
      return '';
    }
  }

  /** 成功回调里的 ?auth=ok 从地址栏抹掉，避免刷新后又出现一次 */
  function stripAuthOk() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('auth') !== 'ok') return;
      q.delete('auth');
      q.delete('reason');
      var rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    } catch (e) { /* 忽略 */ }
  }

  /** 授权失败：停在引导页，给出原因和重试入口（绝不再自动跳授权页） */
  function showAuthError(reason) {
    var box = $('#auth-error');
    if (!box) return;
    var txt = $('#auth-error-reason');
    if (txt) txt.textContent = AUTH_REASON_TEXT[reason] || AUTH_REASON_TEXT.unknown;
    box.classList.remove('hidden');
    var steps = $('#empty-steps');
    if (steps) steps.classList.add('hidden');
    var hint = $('#empty-hint');
    if (hint) hint.classList.add('hidden');
  }

  var authExpiredShownAt = 0;

  /** 会话中途 401：先 flush 防抖中的草稿，再提示重新登录 */
  function showAuthExpired() {
    if (!state.booted) return;                       // 启动阶段由 enterGitHub 负责跳授权
    var box = $('#auth-expired');
    if (!box) return;
    if (!box.classList.contains('hidden')) return;
    if (Date.now() - authExpiredShownAt < 30000) return;  // 批量请求 401 时不反复弹
    authExpiredShownAt = Date.now();
    var saved = saveDraft();                         // scheduleDraft 是 800ms 防抖，这里强制落盘
    var txt = $('#auth-expired-text');
    if (txt) {
      txt.textContent = saved
        ? '需要重新授权 GitHub 才能继续读写仓库。当前改动已存到浏览器本地草稿，重新登录后可以恢复。'
        : '需要重新授权 GitHub 才能继续读写仓库。已经保存到草稿分支的内容不受影响。';
    }
    box.classList.remove('hidden');
  }

  function hideAuthExpired() {
    var box = $('#auth-expired');
    if (box) box.classList.add('hidden');
  }

  function relogin() {
    hideAuthExpired();
    if (window.GitHubStore) GitHubStore.login();
  }

  /** 重新读取 GitHub 列表（sha 没变的文章仍走缓存，不重复拉正文） */
  async function refreshGitHub() {
    if (state.mode !== 'github') return false;
    if (state.current) closeEditor();
    showBusy('正在重新读取列表…');
    try {
      var info = await loadGitHubPosts();
      updateModeUI();
      toast('已刷新，共 ' + info.total + ' 篇' +
        (info.cached ? '（' + info.cached + ' 篇来自缓存）' : ''), 'ok');
      return true;
    } finally {
      hideBusy();
    }
  }

  /** 点左下角 GitHub 状态：仓库信息 / 重新读取 */
  function openGitHubInfo() {
    var body = el('div', { class: 'guide' }, [
      el('p', { class: 'tip', text: '已连接 ' + (state.githubRepo || '') + ' · main，共 ' + state.posts.length + ' 篇文章。' }),
      el('p', { class: 'tip', text: 'main 上的文章是只读的，点「编辑」后保存会写入草稿分支。' })
    ]);
    openModal({
      title: 'GitHub 仓库',
      body: body,
      enterConfirm: false,
      actions: [
        { label: '关闭', value: null },
        { label: '重新读取', primary: true, onClick: function () {
          refreshGitHub().catch(function (e) { toast('刷新失败：' + e.message, 'err'); });
        } }
      ]
    });
  }

  /* ---------------- 图片管理（GitHub 模式） ---------------- */
  var IMG_QUEUE_PREFIX = 'hexo-editor:imgQueue:';
  var imgState = {
    images: [],       // { path, sha, size, draftBranch? }
    refs: null,       // { basename: [引用它的文本文件] }
    scanKey: '',
    scanFailed: 0,
    mainFiles: null,  // 每文件引用快照（main）：{ path: { sha, bases } }
    draftFiles: null, // 每文件引用快照（草稿改动）：{ path: { sha, bases } }
    queue: [],        // 待删除的图片路径
    filter: ''
  };
  var imgDom = { list: null, summary: null, search: null, note: null };

  function imgQueueKey() {
    return IMG_QUEUE_PREFIX + (state.githubRepo || (window.GitHubStore && GitHubStore.repo) || 'default');
  }

  function loadImgQueue() {
    try {
      var arr = JSON.parse(localStorage.getItem(imgQueueKey()) || '[]');
      imgState.queue = Array.isArray(arr) ? arr : [];
    } catch (e) { imgState.queue = []; }
    return imgState.queue;
  }

  function saveImgQueue() {
    try { localStorage.setItem(imgQueueKey(), JSON.stringify(imgState.queue)); } catch (e) { /* 忽略 */ }
  }

  function imgBase(path) { return String(path).split('/').pop().toLowerCase(); }
  function imgRefsOf(img) { return (imgState.refs && imgState.refs[imgBase(img.path)]) || []; }
  function imgQueued(path) { return imgState.queue.indexOf(path) !== -1; }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 当前分支上的图片 + 各草稿分支新增的图片 */
  async function loadImageList() {
    var sig = await getRepoSig();
    var cached = await loadImgScanCache();
    if (cached && cached.sig === sig.key && Array.isArray(cached.images) && cached.images.length) {
      imgState.images = cached.images;
      return cached.images;
    }
    var map = Object.create(null);
    var main = await GitHubStore.listImages('main', sig.mainSha);
    main.forEach(function (x) { map[x.path] = x; });
    for (var i = 0; i < sig.drafts.length; i += 1) {
      var imgs = await GitHubStore.listImages(sig.drafts[i].branch, sig.drafts[i].sha);
      imgs.forEach(function (x) {
        map[x.path] = { path: x.path, sha: x.sha, size: x.size, draftBranch: sig.drafts[i].branch };
      });
    }
    var list = Object.keys(map).sort().map(function (k) { return map[k]; });
    imgState.images = list;
    cached = cached || {};
    cached.sig = sig.key;
    cached.images = list;
    await saveImgScanCache(cached);
    return list;
  }

  /** 全仓引用扫描（增量）：版本没变走缓存；变了只重读变化过的文本文件 */
  async function scanImageRefs() {
    var sig = await getRepoSig();
    if (imgState.refs && imgState.scanKey === sig.key) return imgState.refs;

    var cached = await loadImgScanCache();
    if (cached && cached.sig === sig.key && cached.refs) {
      imgState.refs = cached.refs;
      imgState.scanFailed = cached.failed || 0;
      imgState.scanKey = sig.key;
      imgState.mainFiles = cached.main || null;
      imgState.draftFiles = cached.draft || null;
      return cached.refs;
    }
    if (!imgState.images.length) imgState.images = await loadImageList();

    var mainFiles = await GitHubStore.listTextFiles('main', sig.mainSha);
    var draftFiles = Object.create(null);
    for (var i = 0; i < sig.drafts.length; i += 1) {
      var diff = await GitHubStore.compare('main', sig.drafts[i].sha);
      ((diff && diff.files) || []).forEach(function (f) {
        if (f.status === 'removed' || !f.sha) return;
        if (!/\.(md|markdown|html?|ejs|styl|css|ya?ml|json|js|mjs|txt)$/i.test(f.filename)) return;
        if (/package-lock\.json$/i.test(f.filename)) return;
        draftFiles[f.filename] = f.sha;
      });
    }

    var prevMain = (cached && cached.main) || {};
    var prevDraft = (cached && cached.draft) || {};
    var mainOut = Object.create(null), draftOut = Object.create(null), toRead = [];

    mainFiles.forEach(function (f) {
      var prev = prevMain[f.path];
      if (prev && prev.sha === f.sha) mainOut[f.path] = prev;
      else toRead.push({ path: f.path, sha: f.sha, bucket: 'main' });
    });
    Object.keys(draftFiles).forEach(function (path) {
      var sha = draftFiles[path];
      var prev = prevDraft[path];
      if (prev && prev.sha === sha) draftOut[path] = prev;
      else toRead.push({ path: path, sha: sha, bucket: 'draft' });
    });

    var failed = 0;
    var done = 0;
    setBusyText('正在扫描图片引用 0 / ' + toRead.length);
    var res = await GitHubStore.readBlobs(toRead, function (item, text) {
      var rec = { sha: item.sha, bases: extractImageBases(text) };
      if (item.bucket === 'main') mainOut[item.path] = rec;
      else draftOut[item.path] = rec;
      done += 1;
      if (done % 10 === 0 || done === toRead.length) {
        setBusyText('正在扫描图片引用 ' + done + ' / ' + toRead.length);
      }
    }, { concurrency: 8 });
    failed = (res && res.failed) || 0;

    var refs = Object.create(null);
    function add(path, bases) {
      Object.keys(bases).forEach(function (b) { (refs[b] = refs[b] || []).push(path); });
    }
    Object.keys(mainOut).forEach(function (p) { add(p, mainOut[p].bases); });
    Object.keys(draftOut).forEach(function (p) { add(p, draftOut[p].bases); });

    imgState.refs = refs;
    imgState.scanFailed = failed;
    imgState.scanKey = sig.key;
    imgState.mainFiles = mainOut;
    imgState.draftFiles = draftOut;
    cached = cached || {};
    cached.sig = sig.key;
    cached.refs = refs;
    cached.main = mainOut;
    cached.draft = draftOut;
    cached.failed = failed;
    await saveImgScanCache(cached);
    return refs;
  }

  /** 图片扫描缓存 / 仓库版本签名 */
  function imgScanCacheKey() {
    return 'hexo-editor:imgscan:' + (state.githubRepo || (window.GitHubStore && GitHubStore.repo) || 'default');
  }
  async function loadImgScanCache() {
    try { return await idb.get(imgScanCacheKey()); } catch (e) { return null; }
  }
  async function saveImgScanCache(v) {
    try { await idb.set(imgScanCacheKey(), v); } catch (e) { /* 忽略 */ }
  }
  var repoSig = null;
  async function getRepoSig() {
    if (repoSig && Date.now() - repoSig.at < 5000) return repoSig;
    var mainSha = await GitHubStore.headSha('main');
    var drafts = await GitHubStore.listDrafts();
    repoSig = {
      mainSha: mainSha,
      drafts: drafts,
      key: mainSha + '|' + drafts.map(function (d) { return d.sha; }).join(','),
      at: Date.now()
    };
    return repoSig;
  }
  function invalidateImgCache() {
    repoSig = null;
    state.imageIndex = null;
    imgState.refs = null;
    imgState.scanKey = '';
  }

  /** 从文本里抽出图片文件名（小写，&amp; 还原） */
  function extractImageBases(text) {
    var out = Object.create(null);
    var re = /[A-Za-z0-9_.\-~@+!^&%]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)/gi;
    var m;
    var s = String(text || '').toLowerCase().replace(/&amp;/g, '&');
    while ((m = re.exec(s))) out[m[0]] = true;
    return out;
  }

  /** 本次发布会删掉哪些图片的最后一个引用（→ 变成孤儿） */
  async function orphanedImagesAfterPublish(applied) {
    try {
      return await orphanedImagesAfterPublishInner(applied);
    } catch (e) {
      console.error('[孤儿图检查失败]', e && e.request, e);
      return [];   // 检查失败不能阻塞发布，宁可先不删
    }
  }

  async function orphanedImagesAfterPublishInner(applied) {
    repoSig = null;               // 确保下面拿到的引用快照是「刚保存草稿」之后的最新状态
    await scanImageRefs();        // 走缓存/增量，快；顺带填好 imgState.mainFiles / draftFiles
    if (!imgState.images.length) imgState.images = await loadImageList();

    var byBase = Object.create(null);
    imgState.images.forEach(function (x) { byBase[imgBase(x.path)] = x.path; });

    var mainFiles = imgState.mainFiles || {};
    var draftFiles = imgState.draftFiles || {};
    var changedByPath = Object.create(null);
    var changedList = [];

    for (var i = 0; i < applied.length; i += 1) {
      var files = applied[i].files || [];
      for (var k = 0; k < files.length; k += 1) {
        var f = files[k];
        if (!/\.md$/i.test(f.filename)) continue;
        var oldBases = Object.create(null);
        var newBases = (draftFiles[f.filename] && draftFiles[f.filename].bases) || Object.create(null);
        if (f.status === 'removed') {
          oldBases = (mainFiles[f.filename] && mainFiles[f.filename].bases) || Object.create(null);
          newBases = Object.create(null);
        } else {
          var oldPath = f.status === 'renamed' ? f.previous_filename : f.filename;
          oldBases = (mainFiles[oldPath] && mainFiles[oldPath].bases) || Object.create(null);
          if (f.status === 'renamed' && f.previous_filename) {
            changedByPath[f.previous_filename] = { oldBases: oldBases, newBases: Object.create(null) };
          }
        }
        changedByPath[f.filename] = { oldBases: oldBases, newBases: newBases };
        changedList.push({ path: f.filename, oldBases: oldBases, newBases: newBases });
      }
    }
    if (!changedList.length) return [];

    // 重建「发布后」的引用（纯内存，不读 blob）：
    // main 文件里被发布的用新内容，其余用旧内容；再叠加未发布草稿的改动。
    var found = Object.create(null);
    function absorb(path, bases) {
      Object.keys(bases).forEach(function (b) { (found[b] = found[b] || []).push(path); });
    }
    Object.keys(mainFiles).forEach(function (path) {
      absorb(path, changedByPath[path] ? changedByPath[path].newBases : mainFiles[path].bases);
    });
    changedList.forEach(function (c) {
      if (!(c.path in mainFiles)) absorb(c.path, c.newBases);   // 新增文件
    });
    Object.keys(draftFiles).forEach(function (path) {
      if (changedByPath[path]) return;                          // 已发布，按 new 计过了
      absorb(path, draftFiles[path].bases);                     // 未发布草稿的改动
    });

    var orphan = [];
    changedList.forEach(function (c) {
      Object.keys(c.oldBases).forEach(function (b) {
        if (c.newBases[b]) return;
        if (byBase[b] && !(found[b] && found[b].length)) orphan.push(byBase[b]);
      });
    });
    var result = orphan.filter(function (p, idx) { return orphan.indexOf(p) === idx; });
    console.log('[孤儿图检查]', result);
    return result;
  }

  /** 发布前弹窗：勾选要一并删除的图片，返回选中路径数组 / 空数组（不删）/ null（取消发布） */
  function confirmPublishImages(paths) {
    return new Promise(function (resolve) {
      var checks = paths.map(function (p) {
        var cb = el('input', { type: 'checkbox' });
        cb.checked = true;
        return { path: p, cb: cb, row: el('label', { class: 'img-check' }, [
          cb, el('span', { text: '/' + p.replace(/^source\//, '') })
        ]) };
      });
      openModal({
        title: '这些图片发布后不再被引用',
        body: el('div', {}, [
          el('p', { class: 'tip', text: '下面 ' + paths.length + ' 张图片在发布后将不再被任何文本引用。' +
            '勾选的一并删除；不删也可以在「图片管理」里稍后清理。' }),
          el('div', { class: 'img-check-list' }, checks.map(function (c) { return c.row; }))
        ]),
        actions: [
          { label: '取消发布', value: null },
          { label: '只发布，不删图', value: 'keep' },
          { label: '删除选中并发布', primary: true, value: 'del' }
        ]
      }).then(function (v) {
        if (v === null || v === undefined) { resolve(null); return; }
        if (v === 'keep') { resolve([]); return; }
        resolve(checks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.path; }));
      });
    });
  }

  function renderImageList() {
    var box = imgDom.list;
    if (!box) return;
    box.innerHTML = '';
    var filter = imgState.filter.toLowerCase();
    var list = imgState.images.filter(function (x) {
      return !filter || x.path.toLowerCase().indexOf(filter) !== -1;
    });
    var queued = 0;
    imgState.images.forEach(function (x) { if (imgQueued(x.path)) queued += 1; });

    list.forEach(function (img) {
      var refs = imgRefsOf(img);
      var isQueued = imgQueued(img.path);
      var thumb = el('div', { class: 'img-thumb', title: '点击预览' });
      thumb.onclick = function () { previewImage(img, thumb); };
      var name = el('div', { class: 'img-name' }, [
        el('span', { text: imgBase(img.path) }),
        isQueued ? el('span', { class: 'img-badge', text: '待删除' }) : null,
        img.draftBranch ? el('span', { class: 'img-badge', text: '草稿' }) : null
      ].filter(Boolean));
      var meta = el('div', {
        class: 'img-meta',
        text: '/' + img.path.replace(/^source\//, '') + ' · ' + formatSize(img.size) +
          ' · 引用 ' + refs.length
      });
      var actions = el('div', { class: 'img-actions' });
      var rowEl;
      if (isQueued) {
        actions.appendChild(el('button', {
          class: 'btn tiny', type: 'button', text: '撤销',
          onclick: function () {
            imgState.queue = imgState.queue.filter(function (p) { return p !== img.path; });
            saveImgQueue();
            renderImageList();
          }
        }));
      } else {
        actions.appendChild(el('button', {
          class: 'btn tiny danger', type: 'button', text: '删除',
          onclick: function () { requestDeleteImage(img, rowEl); }
        }));
      }
      rowEl = el('div', { class: 'img-row' }, [
        thumb,
        el('div', { class: 'img-info' }, [name, meta]),
        actions
      ]);
      box.appendChild(rowEl);
    });

    if (!list.length) {
      box.appendChild(el('div', { class: 'img-empty', text: imgState.images.length ? '没有匹配的图片' : '还没有图片' }));
    }
    if (imgDom.summary) {
      imgDom.summary.textContent = '共 ' + imgState.images.length + ' 张' +
        (queued ? ' · 待删除 ' + queued + ' 张（下次发布时一并提交）' : '');
    }
  }

  async function previewImage(img, thumb) {
    if (img._url) { thumb.style.backgroundImage = 'url(' + img._url + ')'; return; }
    try {
      var data = await GitHubStore.readBlobBase64(img.sha);
      var bin = atob(data.base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      if (!window.URL || !URL.createObjectURL) return;
      img._url = URL.createObjectURL(new Blob([bytes]));
      thumb.style.backgroundImage = 'url(' + img._url + ')';
    } catch (e) {
      toast('预览失败：' + e.message, 'err');
    }
  }

  function requestDeleteImage(img, rowEl) {
    if (imgState.scanFailed) {
      toast('有 ' + imgState.scanFailed + ' 个文件读取失败，为避免误删已阻止删除；请刷新后重试', 'err');
      return;
    }
    var refs = imgRefsOf(img);
    if (refs.length) {
      // 在行内展开引用列表，不弹新窗口（弹窗会覆盖图片管理本身）
      if (rowEl.querySelector('.img-refs')) {
        rowEl.querySelector('.img-refs').remove();
        return;
      }
      rowEl.appendChild(el('div', { class: 'img-refs' }, [
        el('div', { class: 'img-refs-tip', text: '仍被 ' + refs.length + ' 个文件引用，先删掉引用：' })
      ].concat(refs.slice(0, 8).map(function (p) {
        return el('div', { class: 'img-ref-path', text: p });
      }))));
      toast('这张图仍被引用，已展开引用列表', 'err');
      return;
    }
    if (!imgQueued(img.path)) {
      imgState.queue.push(img.path);
      saveImgQueue();
      renderImageList();
      toast('已加入待删除，下次发布时一并提交', 'ok');
    }
  }

  function cleanupOrphanImages() {
    if (imgState.scanFailed) {
      toast('有 ' + imgState.scanFailed + ' 个文件读取失败，为避免误删已阻止清理；请刷新后重试', 'err');
      return;
    }
    var orphans = imgState.images.filter(function (x) {
      return !imgRefsOf(x).length && !imgQueued(x.path);
    });
    if (!orphans.length) { toast('没有需要清理的孤儿图'); return; }
    var total = orphans.reduce(function (n, x) { return n + (Number(x.size) || 0); }, 0);
    var note = imgDom.note;
    if (!note) return;
    note.innerHTML = '';
    note.classList.remove('hidden');
    note.appendChild(el('span', {
      text: '有 ' + orphans.length + ' 张图片没有被任何文本引用，合计 ' + formatSize(total) +
        '。加入待删除后随下次发布一起提交：'
    }));
    note.appendChild(el('button', {
      class: 'btn tiny', type: 'button', text: '取消',
      onclick: function () { note.classList.add('hidden'); }
    }));
    note.appendChild(el('button', {
      class: 'btn tiny primary', type: 'button', text: '确认加入',
      onclick: function () {
        orphans.forEach(function (x) { if (!imgQueued(x.path)) imgState.queue.push(x.path); });
        saveImgQueue();
        note.classList.add('hidden');
        renderImageList();
        toast('已加入待删除 ' + orphans.length + ' 张', 'ok');
      }
    }));
  }

  function bytesToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /** 上传图片到当前草稿分支，并尽量把 Markdown 插到正文 */
  /** 把一张图片写进当前草稿分支，返回站内路径（失败返回空串） */
  async function uploadImageToDraft(file) {
    var p = state.current;
    if (!p || !p.draft || p.readOnly || p.removed) {
      toast('图片只能存进草稿：请先点「编辑」并保存一次草稿', 'err');
      return '';
    }
    var b64 = bytesToBase64(await file.arrayBuffer());
    var blobSha = await GitHubStore.createBlobBase64(b64);
    var now = new Date();
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var name = randomImageName(fileExt(file.name));
    var repoPath = GitHubStore.imagesDir + now.getFullYear() + '/' + mm + '/' + name;
    var head = await GitHubStore.branchHead(p.draft.branch);
    var hc = await GitHubStore.getCommit(head);
    var tree = await GitHubStore.createTree(hc.tree.sha, [
      { path: repoPath, mode: '100644', type: 'blob', sha: blobSha }
    ]);
    var commit = await GitHubStore.createCommit('draft: 上传图片 ' + name, tree, [head]);
    await GitHubStore.updateRef(p.draft.branch, commit.sha, false);
    p.draft.head = commit.sha;
    if (state.imageIndex) state.imageIndex.drafts[repoPath] = blobSha;
    repoSig = null;   // 分支 head 变了，下次拿版本签名时重取
    return '/' + repoPath.replace(/^source\//, '');
  }

  async function uploadImages(files) {
    var p = state.current;
    if (!p || !p.draft || p.readOnly || p.removed) {
      toast('请先打开一篇草稿（保存过一次）再上传图片', 'err');
      return;
    }
    showBusy('正在上传图片…');
    var inserted = 0;
    try {
      for (var i = 0; i < files.length; i += 1) {
        setBusyText('正在上传 ' + (i + 1) + ' / ' + files.length + '…');
        var urlPath = await uploadImageToDraft(files[i]);
        if (!urlPath) break;
        if (state.current === p && !p.readOnly) {
          insertBlock('![](' + urlPath + ')', true);
          inserted += 1;
        }
      }
      toast('已上传 ' + files.length + ' 张图片到 ' + p.draft.branch +
        (inserted ? '，并插入正文' : ''), 'ok');
      await refreshImageManager();
    } catch (e) {
      console.error('[上传图片]', e && e.request, e);
      toast('上传失败：' + e.message, 'err');
    } finally {
      hideBusy();
    }
  }

  function buildImageManager() {
    var search = el('input', { type: 'search', placeholder: '筛选文件名…' });
    var upload = el('button', { class: 'btn tiny', type: 'button', text: '上传图片', title: '上传到当前草稿分支' });
    var clean = el('button', { class: 'btn tiny', type: 'button', text: '清理孤儿图' });
    var file = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', class: 'hidden' });
    var list = el('div', { class: 'img-list' });
    var note = el('div', { class: 'img-note hidden' });
    var summary = el('div', { class: 'img-foot' });
    var box = el('div', { class: 'img-mgr' }, [
      el('div', { class: 'img-toolbar' }, [search, upload, clean, file]),
      note,
      list,
      summary
    ]);
    imgDom = { list: list, summary: summary, search: search, note: note };
    search.oninput = function () { imgState.filter = search.value.trim(); renderImageList(); };
    clean.onclick = cleanupOrphanImages;
    upload.onclick = function () { file.click(); };
    file.onchange = function () {
      var picked = Array.prototype.slice.call(file.files || []);
      file.value = '';
      if (picked.length) uploadImages(picked);
    };
    return box;
  }

  async function refreshImageManager() {
    if (!imgDom.list || !document.body.contains(imgDom.list)) return;
    imgDom.list.innerHTML = '<div class="img-empty">正在读取图片列表…</div>';
    showBusy('正在读取图片列表…');
    try {
      loadImgQueue();
      imgState.images = await loadImageList();
      setBusyText('正在扫描图片引用…');
      await scanImageRefs();
      renderImageList();
    } catch (e) {
      console.error('[图片管理]', e && e.request, e);
      toast('图片列表读取失败：' + e.message, 'err');
      imgDom.list.innerHTML = '<div class="img-empty">读取失败</div>';
    } finally {
      hideBusy();
    }
  }

  async function openImageManager() {
    if (state.mode !== 'github') { toast('图片管理只在 GitHub 模式可用', 'err'); return; }
    if (!window.GitHubStore) { toast('GitHub 模块未加载', 'err'); return; }
    openModal({
      title: '图片管理',
      body: buildImageManager(),
      actions: [{ label: '关闭', primary: true, value: true }]
    });
    await refreshImageManager();
  }

  /* ---------------- 草稿分支：保存 / 发布 ---------------- */

  /** 保存到草稿分支（第一次保存才建分支） */
  async function saveGitHubDraft(source, opts) {
    if (!source || source.saving) return false;
    ensureAbbrlink(source);
    var title = String(Core.get(source.doc, 'title') || '').trim();
    if (!title) { toast('请先填写标题', 'err'); return false; }
    var abbr = String(Core.get(source.doc, 'abbrlink') || '').trim().toLowerCase();
    if (!abbr) { toast('缺少 abbrlink，无法建立草稿分支', 'err'); return false; }

    var requested = (opts && opts.name != null) ? opts.name : form.fileName.value;
    var name = Core.sanitizeFilename(String(requested || '').trim() || source.name);
    if (!/\.md$/i.test(name)) name += '.md';
    if (!name || name === '.md') { toast('文件名不合法', 'err'); return false; }

    var path = GitHubStore.postsDir + name;
    var branch = 'draft/' + abbr;
    var oldPath = source.path;
    var oldKey = oldPath ? draftKey({ projectId: source.projectId, path: oldPath }) : '';
    var text = Core.stringifyPost(source.doc);

    source.saving = true;
    showBusy('正在保存到草稿…');
    var step = '读取分支';
    try {
      step = '写入文件内容';
      setBusyText('保存到草稿：' + step);
      var blobSha = await GitHubStore.createBlob(text);
      var entries = [{ path: path, mode: '100644', type: 'blob', sha: blobSha }];
      if (oldPath && oldPath !== path) {
        entries.push({ path: oldPath, mode: '100644', type: 'blob', sha: null });
      }

      step = '检查草稿分支';
      setBusyText('保存到草稿：' + step);
      var head = await GitHubStore.findRef(branch);

      var base = source.draft && source.draft.base ? source.draft.base : null;
      var commitSha;
      if (head) {
        step = '更新草稿提交';
        setBusyText('保存到草稿：' + step);
        var headCommit = await GitHubStore.getCommit(head);
        if (!base) base = (headCommit.parents && headCommit.parents[0] && headCommit.parents[0].sha) || null;
        var tree = await GitHubStore.createTree(headCommit.tree.sha, entries);
        var commit = await GitHubStore.createCommit('draft: ' + title, tree, [head]);
        await GitHubStore.updateRef(branch, commit.sha, false);
        commitSha = commit.sha;
      } else {
        step = '创建草稿分支';
        setBusyText('保存到草稿：' + step);
        var mainSha = await GitHubStore.headSha('main');
        base = mainSha;
        var mainCommit = await GitHubStore.getCommit(mainSha);
        var tree2 = await GitHubStore.createTree(mainCommit.tree.sha, entries);
        var c2 = await GitHubStore.createCommit('draft: ' + title, tree2, [mainSha]);
        try {
          await GitHubStore.createRef(branch, c2.sha);
        } catch (e) {
          if (e.status !== 422 && e.status !== 409) throw e;
          // 分支其实已经存在（上一次尝试建成功了）：退化成更新，不打断用户
          var h2 = await GitHubStore.findRef(branch);
          if (!h2) throw e;
          var hc2 = await GitHubStore.getCommit(h2);
          var t3 = await GitHubStore.createTree(hc2.tree.sha, entries);
          var c3 = await GitHubStore.createCommit('draft: ' + title, t3, [h2]);
          await GitHubStore.updateRef(branch, c3.sha, false);
          c2 = c3;
        }
        commitSha = c2.sha;
      }

      source.path = path;
      source.name = name;
      source.sha = blobSha;
      source.raw = text;
      source.draft = { branch: branch, base: base, head: commitSha };
      source.readOnly = false;
      source.editing = true;
      source.loaded = true;
      source.isNew = false;
      source.dirty = false;
      source.savedOnce = true;
      // 不更新列表缓存：缓存代表 main 上的版本，草稿内容由 mergeDraftBranches 叠上去
      if (oldKey && oldKey !== draftKey(source)) {
        try { localStorage.removeItem(oldKey); } catch (e) { /* 忽略 */ }
      }
      clearDraft(source);
      updateDirtyUI();
      applyLocks();
      applyReadOnly();
      renderList();
      toast('已保存到草稿 ' + branch, 'ok');
      return true;
    } catch (e) {
      console.error('[草稿保存]', e && e.request, e);
      toast('保存草稿失败（' + step + '）：' +
        (e.status === 422 ? '远端已更新，请刷新后重试' : e.message), 'err');
      return false;
    } finally {
      source.saving = false;
      hideBusy();
    }
  }

  /**
   * 把若干草稿分支一次合并到 main：
   * 以当前 main 的 tree 为底，只叠加这些分支改过的文件 → 一个 commit → 更新 ref → 删分支。
   * 有任何冲突就整体拒绝，不会只发布一半。
   */
  async function publishDraftBranches(branches, opts) {
    opts = opts || {};
    if (!branches || !branches.length) return false;
    setBusyText('发布：比对变更');
    var mainSha = await GitHubStore.headSha('main');
    var mainCommit = await GitHubStore.getCommit(mainSha);
    var entries = [];
    var seen = Object.create(null);
    var applied = [];

    for (var i = 0; i < branches.length; i += 1) {
      var branch = branches[i];
      var post = state.posts.filter(function (x) { return x.draft && x.draft.branch === branch; })[0] || null;
      var head = await GitHubStore.branchHead(branch);
      var diff = await GitHubStore.compare(mainSha, head);
      var files = (diff && diff.files) || [];
      if (!files.length) continue;                    // 没有差异的分支跳过

      var base = post && post.draft ? post.draft.base : null;
      if (base && base !== mainSha) {
        var moved = await GitHubStore.compare(base, mainSha);
        var touched = Object.create(null);
        ((moved && moved.files) || []).forEach(function (f) {
          touched[f.filename] = true;
          if (f.previous_filename) touched[f.previous_filename] = true;
        });
        var clash = files.filter(function (f) {
          return touched[f.filename] || (f.previous_filename && touched[f.previous_filename]);
        });
        if (clash.length) {
          toast('「' + (post ? String(Core.get(post.doc, 'title') || post.name) : branch) +
            '」与 main 冲突（' + clash[0].filename + '），请重新打开该草稿', 'err');
          return false;
        }
      }

      for (var k = 0; k < files.length; k += 1) {
        var f = files[k];
        var paths = [f.filename].concat(f.previous_filename ? [f.previous_filename] : []);
        for (var t = 0; t < paths.length; t += 1) {
          if (seen[paths[t]]) {
            toast('两篇草稿都改了 ' + paths[t] + '，请先合并内容再批量发布', 'err');
            return false;
          }
          seen[paths[t]] = branch;
        }
        if (f.status === 'renamed' && f.previous_filename) {
          entries.push({ path: f.previous_filename, mode: '100644', type: 'blob', sha: null });
        }
        entries.push({
          path: f.filename,
          mode: '100644',
          type: 'blob',
          sha: f.status === 'removed' ? null : f.sha
        });
      }
      applied.push({ branch: branch, files: files, post: post });
    }

    if (!applied.length) { toast('所选草稿与 main 没有差异', 'err'); return false; }

    // 图片管理里的「待删除」队列，随这次发布一起提交，不单独产生部署
    var queuedImgs = loadImgQueue().filter(function (path) { return !seen[path]; });
    queuedImgs.forEach(function (path) {
      seen[path] = 'queue';
      entries.push({ path: path, mode: '100644', type: 'blob', sha: null });
    });

    // §8.6：本次改动删掉最后引用 → 变成孤儿的图片，弹窗确认是否一并删除
    var removeImgs = [];
    if (!opts.skipOrphanCheck) {
      var orphans = await orphanedImagesAfterPublish(applied);
      if (orphans.length) {
        hideBusy();
        var decision = await confirmPublishImages(orphans);
        showBusy('正在发布到 main…');
        if (decision === null) { toast('已取消发布', 'err'); return false; }
        removeImgs = decision;
      }
    }
    removeImgs.forEach(function (path) {
      if (!seen[path]) {
        seen[path] = 'orphan';
        entries.push({ path: path, mode: '100644', type: 'blob', sha: null });
      }
    });

    var titles = applied.map(function (a) {
      return a.post
        ? String(Core.get(a.post.doc, 'title') || a.post.name).replace(/\.md$/i, '').trim()
        : a.branch;
    });
    var message = titles.length === 1
      ? 'post: ' + titles[0]
      : 'post: 发布 ' + titles.length + ' 篇：' + titles.join('、');
    var imgDel = queuedImgs.length + removeImgs.length;
    if (imgDel) message += '（含 ' + imgDel + ' 张图片删除）';
    if (message.length > 120) message = message.slice(0, 117) + '…';

    setBusyText('发布：创建提交');
    var tree = await GitHubStore.createTree(mainCommit.tree.sha, entries);
    var commit = await GitHubStore.createCommit(message, tree, [mainSha]);

    setBusyText('发布：更新 main');
    await GitHubStore.updateRef('main', commit.sha, false);

    applied.forEach(function (a) {
      var post = a.post;
      if (post && post.removed) {
        // 删除型草稿发布完成：从列表里移除
        state.posts = state.posts.filter(function (x) { return x !== post; });
        state.selected.delete(a.branch);
        clearDraft(post);
        GitHubStore.deleteRef(a.branch).catch(function () { /* 忽略 */ });
        if (state.current === post) closeEditor();
        return;
      }
      if (post) {
        var mine = a.files.filter(function (f) { return f.filename === post.path; })[0];
        if (mine && mine.sha) post.sha = mine.sha;
        post.draft = null;
        post.removed = false;
        post.readOnly = true;
        post.editing = false;
        post.dirty = false;
        post.savedOnce = true;
        post.mainExists = true;      // 发布后它已经在 main 上了，删除要走「待删除」流程
        clearDraft(post);
        rememberMeta(post, post.doc);
      }
      state.selected.delete(a.branch);
      GitHubStore.deleteRef(a.branch).catch(function () { /* 删分支失败不影响发布 */ });
    });

    updateDirtyUI();
    applyReadOnly();
    renderList();
    invalidateImgCache();
    if (queuedImgs.length) {
      imgState.queue = imgState.queue.filter(function (p) { return queuedImgs.indexOf(p) === -1; });
      saveImgQueue();
      if (imgDom.list && document.body.contains(imgDom.list)) renderImageList();
    }
    if (removeImgs.length) {
      imgState.images = imgState.images.filter(function (x) { return removeImgs.indexOf(x.path) === -1; });
      imgState.refs = null;
      imgState.scanKey = '';
      if (imgDom.list && document.body.contains(imgDom.list)) renderImageList();
    }
    toast(titles.length === 1
      ? '已发布，Netlify 将开始构建'
      : '已发布 ' + titles.length + ' 篇，Netlify 只构建一次', 'ok');
    return true;
  }

  /** 单篇发布：确认后走统一的批量发布 */
  async function publishGitHubDraft() {
    var p = state.current;
    if (!p) return false;
    if (!p.draft) { toast('请先保存草稿，再发布', 'err'); return false; }
    if (p.saving) return false;
    var branch = p.draft.branch;
    var ok = await openModal({
      title: '发布到网站',
      body: '<p class="tip">会把草稿分支 <code>' + escapeHtml(branch) + '</code> 合并到 <code>main</code>，' +
        '然后删除该草稿分支。Netlify 将开始构建，通常 2–4 分钟。</p>',
      actions: [{ label: '取消', value: null }, { label: '发布', primary: true, value: true }]
    });
    if (!ok) return false;

    p.saving = true;
    showBusy('正在发布到 main…');
    try {
      return await publishDraftBranches([branch]);
    } catch (e) {
      console.error('[发布]', e && e.request, e);
      if (e.status === 422) toast('main 已被更新，发布被拒绝，请重新打开草稿', 'err');
      else toast('发布失败：' + e.message, 'err');
      return false;
    } finally {
      p.saving = false;
      hideBusy();
    }
  }

  /** 批量发布：侧栏勾选的草稿一次合并 */
  async function publishSelectedDrafts() {
    var branches = Array.from(state.selected);
    if (!branches.length) return false;
    if (branches.length > 20) { toast('一次最多发布 20 篇，请分批操作', 'err'); return false; }
    if (state.current && state.current.dirty) {
      toast('当前打开的文章还有未保存修改，请先保存草稿', 'err');
      return false;
    }

    var titles = branches.map(function (b) {
      var post = state.posts.filter(function (x) { return x.draft && x.draft.branch === b; })[0];
      return post ? String(Core.get(post.doc, 'title') || post.name).replace(/\.md$/i, '').trim() : b;
    });
    var listBox = el('ul', { class: 'pub-list' }, titles.map(function (t) {
      return el('li', { text: t });
    }));
    var box = el('div', {}, [
      el('p', {
        class: 'tip',
        html: '会把 ' + branches.length + ' 个草稿分支合并到 <code>main</code>，然后删除这些分支。' +
          'Netlify 只构建一次，通常 2–4 分钟。'
      }),
      listBox
    ]);
    var ok = await openModal({
      title: '发布到网站',
      body: box,
      actions: [
        { label: '取消', value: null },
        { label: '发布 ' + branches.length + ' 篇', primary: true, value: true }
      ]
    });
    if (!ok) return false;

    showBusy('正在发布 ' + branches.length + ' 篇…');
    try {
      return await publishDraftBranches(branches);
    } catch (e) {
      console.error('[批量发布]', e && e.request, e);
      if (e.status === 422) toast('main 已被更新，发布被拒绝，请刷新后重试', 'err');
      else toast('发布失败：' + e.message, 'err');
      return false;
    } finally {
      hideBusy();
    }
  }

  /** 把 draft/* 分支合并进列表（一篇草稿一条，和 main 的同名文章合并显示） */
  async function mergeDraftBranches() {
    if (state.mode !== 'github') return;
    var refs;
    try { refs = await GitHubStore.listDrafts(); } catch (e) { return; }
    if (!refs.length) { state.draftCount = 0; return; }

    var byAbbr = Object.create(null);
    state.posts.forEach(function (p) {
      var a = String(Core.get(p.doc, 'abbrlink') || '').toLowerCase();
      if (a) byAbbr[a] = p;
    });

    for (var i = 0; i < refs.length; i += 1) {
      var ref = refs[i];
      try {
        var headCommit = await GitHubStore.getCommit(ref.sha);
        var base = (headCommit.parents && headCommit.parents[0] && headCommit.parents[0].sha) || null;
        // 只看这个分支相对 main 真正改过的文件；不能拿整棵树，否则所有文章都会被当成草稿
        var diff = await GitHubStore.compare('main', ref.sha);
        var changed = ((diff && diff.files) || []).filter(function (f) {
          return f.filename.indexOf(GitHubStore.postsDir) === 0 && /\.md$/i.test(f.filename);
        });
        for (var k = 0; k < changed.length; k += 1) {
          var f = changed[k];
          if (f.status === 'removed' || !f.sha) {
            // 分支里删掉了文件：main 上的同路径文章标记为「待删除」
            var gone = state.posts.filter(function (x) { return x.path === f.filename; })[0] || null;
            if (gone && gone !== state.current) {
              gone.draft = { branch: ref.branch, base: base, head: ref.sha };
              gone.removed = true;
              gone.readOnly = true;
              gone.editing = false;
            }
            continue;
          }
          var path = f.filename;
          var name = path.slice(GitHubStore.postsDir.length);
          var text = await GitHubStore.readBlob(f.sha);
          var doc = Core.parsePost(text);
          var abbr = String(Core.get(doc, 'abbrlink') || '').toLowerCase();
          var target = (abbr && byAbbr[abbr]) ||
            state.posts.filter(function (x) { return x.path === path; })[0] || null;
          // 正在编辑的这篇不动：编辑器里显示的是 memory 里的内容，替换 doc 会和可见正文对不上
          if (target && target === state.current) continue;
          if (target) {
            target.path = path;
            target.name = name;
            target.doc = doc;
            target.raw = text;
            target.sha = f.sha;
            target.loaded = true;
            target.readOnly = false;
            target.editing = true;
            target.draft = { branch: ref.branch, base: base, head: ref.sha };
            target.meta = metaOf(doc);
            if (abbr) byAbbr[abbr] = target;
          } else {
            var np = {
              id: uid(),
              path: path,
              name: name,
              doc: doc,
              raw: text,
              sha: f.sha,
              dirty: false,
              savedOnce: true,
              github: true,
              readOnly: false,
              editing: true,
              loaded: true,
              mainExists: false,
              draft: { branch: ref.branch, base: base, head: ref.sha }
            };
            np.meta = metaOf(np.doc);
            if (abbr) byAbbr[abbr] = np;
            state.posts.push(np);
          }
        }
      } catch (e) { /* 单个分支失败不影响其余 */ }
    }
    state.draftCount = refs.length;
    reindex();
    renderList();
  }

  /** GitHub 模式下新建文章：只存在于内存，第一次保存才建草稿分支 */
  async function newGitHubPost() {
    commitCurrentDraft();
    var title = await promptText('新建文章', '标题 title', '', '文章标题');
    if (title == null) return;
    var now = new Date();
    var doc = Core.createPost({ title: title, description: '', tags: [], cover: '' });
    Core.set(doc, 'date', Core.formatDateTime(now));
    Core.set(doc, 'abbrlink', Core.allocateAbbrlink(title, usedAbbrlinks(null)));
    var name = unusedName(Core.suggestFilename(title, now, 'yy'));
    var p = {
      id: uid(),
      path: GitHubStore.postsDir + name,
      name: name,
      doc: doc,
      raw: '',
      dirty: true,
      savedOnce: false,
      isNew: true,
      github: true,
      readOnly: false,
      editing: true,
      loaded: true,
      mainExists: false
    };
    state.posts.unshift(p);
    openPost(p, { skipDraftCheck: true });
    form.fileName.select();
    toast('新文章：保存后创建草稿分支 draft/' + Core.get(doc, 'abbrlink'));
  }

  /** 日期 / abbrlink 的锁定规则 */
  function applyLocks() {
    if (!state.current) return;
    var abbr = String(Core.get(state.current.doc, 'abbrlink') || '').trim();
    form.abbrlink.disabled = false;
    var regen = $('#btn-regen-link');
    if (regen) {
      regen.title = abbr
        ? '按标题重新生成 abbrlink（会改变文章 URL）'
        : '按标题生成 abbrlink';
    }

    var dateUnlocked = !!state.current.savedOnce;
    form.date.disabled = !dateUnlocked;
    $('#lock-date').textContent = dateUnlocked ? '🔓' : '🔒';
    $('#lock-date').classList.toggle('unlocked', dateUnlocked);
    $('#lock-date').title = dateUnlocked ? '可编辑' : '锁定：文件保存一次后才可修改日期';
  }

  /* ================================================================
   * 6. 表单 → doc
   * ================================================================ */
  function markDirty() {
    var p = state.current;
    if (!p || suppress) return;
    p.dirty = true;
    updateDirtyUI();
    renderList();
    scheduleDraft();
    renderFrontMatter();
    validateAndShow();
  }

  function updateDirtyUI() {
    var p = state.current;
    $('#dirty-dot').classList.toggle('on', !!(p && p.dirty));
    var s = $('#save-state');
    if (!p) { s.textContent = '—'; s.className = 'save-state'; return; }
    if (p.dirty) { s.textContent = '未保存'; s.className = 'save-state dirty'; }
    else { s.textContent = '已保存'; s.className = 'save-state saved'; }
  }

  function setField(key, value) {
    if (!state.current) return;
    if (JSON.stringify(Core.get(state.current.doc, key)) === JSON.stringify(value)) return;
    Core.set(state.current.doc, key, value);
    markDirty();
  }

  /* ---- tags ---- */
  function renderChips() {
    var tags = Core.get(state.current.doc, 'tags') || [];
    var box = form.tagsChips;
    box.innerHTML = '';
    tags.forEach(function (t, i) {
      box.appendChild(el('span', { class: 'chip' }, [
        el('span', { text: t }),
        el('button', {
          type: 'button', text: '×', title: '移除',
          onclick: function () {
            var arr = (Core.get(state.current.doc, 'tags') || []).slice();
            arr.splice(i, 1);
            setField('tags', arr);
            renderChips();
          }
        })
      ]));
    });
    renderSuggest();
  }

  function renderSuggest() {
    var box = $('#tag-suggest');
    box.innerHTML = '';
    if (!state.allTags) return;
    var have = Core.get(state.current.doc, 'tags') || [];
    var q = form.tagsInput.value.trim().toLowerCase();
    var candidates = Array.from(state.allTags.keys())
      .filter(function (t) { return have.indexOf(t) === -1 && (!q || t.toLowerCase().indexOf(q) !== -1); })
      .sort(function (a, b) { return state.allTags.get(b) - state.allTags.get(a); })
      .slice(0, 14);
    candidates.forEach(function (t) {
      box.appendChild(el('button', {
        type: 'button', text: '+ ' + t, title: '点击添加',
        onclick: function () { addTag(t); }
      }));
    });
  }

  function addTag(raw) {
    var parts = String(raw).split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    var arr = (Core.get(state.current.doc, 'tags') || []).slice();
    parts.forEach(function (t) { if (arr.indexOf(t) === -1) arr.push(t); });
    setField('tags', arr);
    form.tagsInput.value = '';
    renderChips();
  }

  /* ---- cover ---- */
  var coverRequest = 0;
  function updateCoverPreview() {
    var request = ++coverRequest;
    var post = state.current;
    var box = $('#cover-preview');
    var path = String(form.cover.value || '').trim();
    if (!path) {
      box.textContent = '无封面';
      box.classList.remove('has-img');
      box.style.backgroundImage = '';
      return;
    }
    box.textContent = '加载中…';
    resolveImageUrl(path).then(function (url) {
      if (request !== coverRequest || state.current !== post || form.cover.value.trim() !== path) return;
      if (!url) {
        box.textContent = '无法预览';
        box.classList.remove('has-img');
        box.style.backgroundImage = '';
        return;
      }
      box.textContent = '';
      box.classList.add('has-img');
      box.style.backgroundImage = 'url("' + url + '")';
    });
  }

  /** 站内路径 → 可显示的 URL：草稿分支里的图从 blob 读，其余走站点路径 */
  function resolveImageUrl(path) {
    if (!path) return Promise.resolve('');
    path = String(path).trim();
    if (/^https?:/i.test(path)) return Promise.resolve(path);
    if (path.charAt(0) !== '/') return Promise.resolve('');
    if (path.indexOf('/images/') === 0) {
      return previewDraftImage(path).then(function (url) { return url || path; });
    }
    return Promise.resolve(path);
  }

  // 草稿分支图片预览：path → { sha, url } 缓存
  var imgPreviewCache = Object.create(null);

  /**
   * 全局图片索引：main 上已有的 + 所有草稿分支里的。
   * 用来判断某张图是「已发布（走站点路径）」还是「只在草稿分支（走 blob）」，跟当前打开哪篇无关。
   */
  async function ensureImageIndex() {
    var sig = await getRepoSig();
    if (state.imageIndex && state.imageIndex.key === sig.key) return state.imageIndex;

    var main = await GitHubStore.listImages('main', sig.mainSha);
    var mainSet = Object.create(null);
    main.forEach(function (x) { mainSet[x.path] = x.sha; });

    var draftMap = Object.create(null);
    for (var i = 0; i < sig.drafts.length; i += 1) {
      var imgs = await GitHubStore.listImages(sig.drafts[i].branch, sig.drafts[i].sha);
      imgs.forEach(function (x) {
        if (!(x.path in draftMap)) draftMap[x.path] = x.sha;
      });
    }
    state.imageIndex = { key: sig.key, main: mainSet, drafts: draftMap };
    return state.imageIndex;
  }

  function previewDraftImage(path) {
    var repoPath = path.replace(/^\/images\//, 'source/images/');
    return ensureImageIndex().then(function (idx) {
      // 草稿分支或 main 上都有这张图时，直接从 GitHub 读 blob 预览：
      // 不依赖 zerokami.cn 是否已经重新构建，避免刚发布那几分钟的 404。
      var sha = idx.drafts[repoPath] || idx.main[repoPath];
      if (!sha) return '';
      var hit = imgPreviewCache[path];
      if (hit && hit.sha === sha) return hit.url;
      return GitHubStore.readBlobBase64(sha).then(function (data) {
        var bin = atob(data.base64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        if (!window.URL || !URL.createObjectURL) return '';
        var url = URL.createObjectURL(new Blob([bytes]));
        imgPreviewCache[path] = { sha: sha, url: url };
        return url;
      }).catch(function () { return ''; });
    }).catch(function () { return ''; });
  }

  /** 把选中的图片写入 source/images 并返回站内路径 */
  async function importImage(file) {
    if (!state.current) { toast('请先打开一篇文章', 'err'); return ''; }
    showBusy('正在上传图片…');
    try {
      var up = await uploadImageToDraft(file);
      if (up) toast('图片已上传到草稿分支 ' + state.current.draft.branch, 'ok');
      return up;
    } catch (e) {
      console.error('[上传图片]', e && e.request, e);
      toast('上传失败：' + e.message, 'err');
      return '';
    } finally {
      hideBusy();
    }
  }

  /* ================================================================
   * 7. 校验 & Front Matter 预览
   * ================================================================ */
  function validateAndShow() {
    if (!state.current) return;
    var issues = Core.validate(state.current.doc);
    $$('.msg').forEach(function (m) { m.textContent = ''; m.className = 'msg'; });
    $$('.field').forEach(function (f) { f.classList.remove('invalid'); });
    issues.forEach(function (i) {
      var m = document.querySelector('.msg[data-for="' + i.field + '"]');
      if (m) {
        m.textContent = i.message;
        m.className = 'msg' + (i.level === 'error' ? ' error' : '');
        var field = m.closest('.field');
        if (field && i.level === 'error') field.classList.add('invalid');
      }
    });
    return issues;
  }

  function renderFrontMatter() {
    if (!state.current) return;
    var text = Core.stringifyPost(state.current.doc);
    var split = Core.splitFront(text);
    $('#frontmatter-view').textContent = split.hasFront
      ? '---\n' + split.front.join('\n') + '\n---'
      : '(无 front matter)';
  }

  /* ================================================================
   * 8. 正文编辑（所见即所得，但底层仍是纯文本 markdown）
   *
   * 模型：bodyEl 里「一行一个 div」，每行 textContent 就是该行的原始
   * markdown。光标所在行保持原文（.editing），其余行做渲染 —— 标题变大、
   * 标记隐藏、行内格式生效。这样保存时逐字节不变，打字时又能立刻看到
   * 块级效果；回车/退格/粘贴/撤销都自己接管，不依赖 execCommand。
   * ================================================================ */
  var bodyEl = null;
  var activeLine = null;      // 当前正在编辑（保持原文）的那一行
  var composing = false;      // 输入法组字中：不做任何 DOM 手术
  var lastAbs = 0;            // 最近一次光标位置（焦点离开正文后仍可用）
  var hist = [];
  var histIdx = -1;
  var keepHistory = false;    // 撤销/重做回放时不要再记历史

  var LINE_RE = {
    fence: /^\s{0,3}(```|~~~)/,
    atx: /^\s{0,3}(#{1,6})\s+/,
    quote: /^\s{0,3}>\s?/,
    task: /^(\s{0,3})([-*+])\s+\[[ xX]\]\s+/,
    ul: /^(\s{0,3})[-*+]\s+/,
    ol: /^(\s{0,3})(\d+)([.)])\s+/,
    indent: /^( {4}|\t)/,
    htmlBlock: /^\s{0,3}<(div|script|iframe|table|center|details|p|img|br)\b/i
  };

  /** 判定一行属于哪种块（fence 状态跨行传递） */
  function lineType(text, st) {
    if (!text.trim()) return st.inFence ? 'code' : 'p';
    if (LINE_RE.fence.test(text)) { st.inFence = !st.inFence; return 'fence'; }
    if (st.inFence) return 'code';
    var m = LINE_RE.atx.exec(text);
    if (m) return 'h' + m[1].length;
    if (LINE_RE.task.test(text)) return /\[[xX]\]/.test(text) ? 'task-done' : 'task';
    if (LINE_RE.ul.test(text)) return 'ul';
    if (LINE_RE.ol.test(text)) return 'ol';
    if (LINE_RE.quote.test(text)) return 'quote';
    if (LINE_RE.indent.test(text)) return 'code';
    if ((text.replace(/\s/g, '').match(/^([-*_])(\1){2,}$/))) return 'hr';
    if (/^\s{0,3}\|/.test(text)) return 'table';
    if (LINE_RE.htmlBlock.test(text)) return 'html';
    return 'p';
  }

  function lineEls() {
    return bodyEl ? Array.prototype.slice.call(bodyEl.children) : [];
  }

  /** 一行的纯文本（把 nbsp 还原成空格、把 <br> 还原成 \n，避免存盘时丢字符） */
  function textOf(node) {
    if (node.querySelector && node.querySelector('br')) {
      var parts = [];
      Array.prototype.forEach.call(node.childNodes, function (c) {
        if (c.nodeName === 'BR') parts.push('\n');
        else parts.push(c.textContent || '');
      });
      return parts.join('').replace(/\u00a0/g, ' ');
    }
    return String(node.textContent || '').replace(/\u00a0/g, ' ');
  }

  /** 某一行里混进了换行（浏览器偶尔会这么干）→ 要重新按行拆一次 */
  function hasStrayNewline() {
    return lineEls().some(function (l) { return textOf(l).indexOf('\n') !== -1; });
  }

  function bodyText() {
    return lineEls().map(textOf).join('\n');
  }

  /** (节点, 偏移) → 整篇里的绝对字符偏移；不在正文里返回 -1 */
  function absOf(container, offset) {
    if (!bodyEl) return -1;
    var lines = lineEls();
    if (container === bodyEl) {
      var idx = Math.max(0, Math.min(offset, lines.length - 1));
      var p0 = 0;
      for (var k = 0; k < idx; k++) p0 += textOf(lines[k]).length + 1;
      return p0;
    }
    var pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.contains(container)) {
        var total = 0;
        var done = false;
        (function walk(n) {
          if (done) return;
          if (n === container) {
            if (n.nodeType === 3) total += Math.min(offset, n.nodeValue.length);
            else for (var j = 0; j < offset && j < n.childNodes.length; j++) total += (n.childNodes[j].textContent || '').length;
            done = true;
            return;
          }
          if (n.nodeType === 3) { total += n.nodeValue.length; return; }
          for (var c = 0; c < n.childNodes.length; c++) walk(n.childNodes[c]);
        })(line);
        return pos + total;
      }
      pos += textOf(line).length + 1;
    }
    return -1;
  }

  /** 当前选区（绝对偏移）；焦点不在正文时退回上次的位置 */
  function selInfo() {
    var s = window.getSelection();
    if (!s || !s.rangeCount || !bodyEl) return null;
    var r = s.getRangeAt(0);
    var a = absOf(r.startContainer, r.startOffset);
    var b = absOf(r.endContainer, r.endOffset);
    if (a < 0 || b < 0) return null;
    return a <= b ? { a: a, b: b } : { a: b, b: a };
  }

  function locate(abs) {
    var lines = lineEls();
    if (!lines.length) return null;
    var pos = 0;
    for (var i = 0; i < lines.length; i++) {
      var len = textOf(lines[i]).length;
      if (abs <= pos + len) return { el: lines[i], off: abs - pos };
      pos += len + 1;
    }
    var last = lines[lines.length - 1];
    return { el: last, off: textOf(last).length };
  }

  function pointIn(el, off) {
    var remain = off, lastText = null;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (remain <= n.nodeValue.length) return { node: n, offset: remain };
      remain -= n.nodeValue.length;
      lastText = n;
    }
    if (lastText) return { node: lastText, offset: lastText.nodeValue.length };
    return { node: el, offset: 0 };
  }

  function setCaret(a, b) {
    if (b == null) b = a;
    var s1 = locate(a), s2 = locate(b);
    if (!s1 || !s2) return;
    var p1 = pointIn(s1.el, s1.off), p2 = pointIn(s2.el, s2.off);
    var range = document.createRange();
    try {
      range.setStart(p1.node, p1.offset);
      range.setEnd(p2.node, p2.offset);
    } catch (e) { return; }
    if (bodyEl && document.activeElement !== bodyEl) { try { bodyEl.focus(); } catch (e) { /* 忽略 */ } }
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastAbs = a;
  }

  /* ---------------- 行内渲染 ---------------- */
  var INLINE_RE = new RegExp(
    '(`[^`\\n]+`)' +                                   // 1 行内代码
    '|\\*\\*([^*\\n]+)\\*\\*' +                        // 2 粗体
    '|__([^_\\n]+)__' +                                // 3 粗体
    '|~~([^~\\n]+)~~' +                                // 4 删除线
    '|\\*([^*\\n]+)\\*' +                              // 5 斜体
    '|!\\[([^\\]\\n]*)\\]\\(([^)\\n]*)\\)' +           // 6/7 图片
    '|\\[([^\\]\\n]+)\\]\\(([^)\\n]*)\\)',             // 8/9 链接
    'g'
  );

  /**
   * 图片预览节点：<img> 的 textContent 恒为空串，不影响读回原文。
   * 重建（renderBody 会整段 innerHTML = ''）时图片是全新节点、还没 src，
   * 若不预占位就会从 300px 塌到 18px，加载完再弹回去，把下方内容顶下去
   * —— 表现就是「插入图片后粘贴文字，页面往下跳一段」。
   * 所以这里用上次加载后记下的尺寸先撑住，加载完再把内联尺寸交还给 CSS。
   */
  function imgNode(src) {
    var img = document.createElement('img');
    img.className = 'ed-img';
    img.setAttribute('data-src', String(src || ''));
    img.alt = '';
    var size = state.imgSize.get(String(src || ''));
    if (size && size.h > 0) {
      img.style.minHeight = size.h + 'px';
      if (size.w > 0) img.style.width = size.w + 'px';
    }
    // 之前已经拿过 blob 地址的图，重建时直接带上 src，避免「先空白、再加载」的闪烁
    var hit = imgPreviewCache[String(src || '')];
    if (hit && hit.url) img.src = hit.url;
    return img;
  }

  var IMG_PENDING = Object.create(null);

  /** 给渲染出来、但还没拿到真实地址的 <img> 补上 src（异步，逐张） */
  function hydrateImages(root) {
    var scope = root && root.querySelectorAll ? root : bodyEl;
    if (!scope) return;
    var imgs = scope.querySelectorAll('img.ed-img[data-src]');
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.getAttribute('data-done')) return;
      img.setAttribute('data-done', '1');
      var src = img.getAttribute('data-src');
      if (!src) { markImgBad(img); return; }

      function onLoad() {
        if (!img.naturalWidth) { markImgBad(img); return; }
        img.classList.add('ok');
        // 占位用的内联尺寸交还给 CSS，再记录真实渲染尺寸（供下次重建占位）
        img.style.minHeight = '';
        img.style.width = '';
        var r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          state.imgSize.set(String(src), { w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', function () { markImgBad(img); }, { once: true });
      // imgNode 里可能已经同步带上了缓存的 src，若已加载完就直接收尾
      if (img.getAttribute('src') && img.complete) onLoad();

      Promise.resolve(resolveImageUrl(src)).then(function (url) {
        if (!url || !img.isConnected) { markImgBad(img); return; }
        if (img.getAttribute('src') !== url) img.src = url;   // 不同才重设，避免重复触发加载
      }).catch(function () { markImgBad(img); });
    });
  }

  /** 图加载不出来时退回原来的「🖼 alt」小徽标，别让人对着一片空白 */
  function markImgBad(img) {
    img.classList.add('bad');
    // 清掉占位尺寸：图都坏了就别再撑着一大片空白
    img.style.minHeight = '';
    img.style.width = '';
    var prev = img.previousElementSibling;
    if (prev && prev.getAttribute && prev.getAttribute('data-i') === 'img') {
      prev.classList.add('show-fallback');
    }
  }

  /* ---------------- 表格 ---------------- */

  /** `| a | b |` → ['a', 'b']（首尾竖线可有可无） */
  function splitCells(text) {
    var s = String(text == null ? '' : text).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  /** `|---|:--:|` 这种分隔行 */
  function isSepRow(cells) {
    if (!cells.length) return false;
    return cells.every(function (c) { return /^:?-{2,}:?$/.test(c.trim()); });
  }

  function alignOfCell(c) {
    var s = c.trim();
    var l = s.charAt(0) === ':';
    var r = s.charAt(s.length - 1) === ':';
    return l && r ? 'center' : r ? 'right' : '';
  }

  /**
   * 一个表格块的「列数 / 每列对齐」。
   * 每行渲染时自己算一遍（而不是统一刷一遍全表），这样单独重绘某一行
   * 也不会把对齐丢掉 —— 早期版本挂在批量刷新上，光标挪动重绘表头后就丢了。
   */
  function tableBlockInfo(lineEl, selfText) {
    var start = lineEl;
    while (start.previousElementSibling &&
           start.previousElementSibling.getAttribute('data-t') === 'table') {
      start = start.previousElementSibling;
    }
    var cols = 2, align = null, n = start;
    while (n && n.getAttribute('data-t') === 'table') {
      var cs = splitCells(n === lineEl && selfText != null ? selfText : textOf(n));
      cols = Math.max(cols, cs.length);
      if (!align && isSepRow(cs)) align = cs.map(alignOfCell);
      n = n.nextElementSibling;
    }
    return { cols: cols, align: align };
  }

  /**
   * 表格行视觉化。约束同样是 textContent 不能变：
   * 原文放进隐藏 span，单元格文字由 `.tc::before { content: attr(data-c) }`
   * 渲染 —— 伪元素产生的文字不算 textContent，所以读回来还是 `| a | b |`。
   */
  function renderTableLine(lineEl, raw) {
    var cells = splitCells(raw);
    var sep = isSepRow(cells);
    var prev = lineEl.previousElementSibling;
    var head = !sep && !(prev && prev.getAttribute('data-t') === 'table');
    var info = tableBlockInfo(lineEl, raw);
    lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: raw }));
    var cursor = 0;
    if (sep) {
      lineEl.setAttribute('data-sep', '1');
      lineEl.removeAttribute('data-head');
    } else {
      lineEl.removeAttribute('data-sep');
      if (head) lineEl.setAttribute('data-head', '1');
      else lineEl.removeAttribute('data-head');
      cells.forEach(function (c, idx) {
        var at = raw.indexOf(c, cursor);
        if (at < 0) at = cursor;
        cursor = at + c.length;
        var cell = el('span', { class: 'tc', 'data-c': c, 'data-at': String(at) });
        var al = info.align && info.align[idx];
        if (al) cell.setAttribute('data-al', al);
        lineEl.appendChild(cell);
      });
    }
    lineEl.style.setProperty('--cols', info.cols);
  }

  /* ---------------- 视频块 ---------------- */

  /** 视频块两种形态：
   *  1) 自动选择（判断网络）：`<div id="videoContainer">…</div><script>…</script>` 多行；
   *  2) 二选一（固定平台）：单行 iframe（`<div …><iframe …></div>` 或 `<iframe …>`）。 */
  function isVideoContainer(text) {
    return /^\s*<div\s+id=["']?videoContainer/i.test(text);
  }
  function isVideoEnd(text) {
    return /^\s*<\/script>\s*$/i.test(text);
  }
  function hasVideoIframe(text) {
    return /player\.bilibili\.com\/player\.html|youtube\.com\/embed/.test(text);
  }

  /** 遍历行，给视频块打标记：data-vblock=1（块内所有行）、data-vhead=1（首行） */
  function refreshVideoBlocks() {
    var lines = lineEls();
    lines.forEach(function (l) { l.removeAttribute('data-vblock'); l.removeAttribute('data-vhead'); });
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var t = line.getAttribute('data-t');
      var txt = textOf(line);
      // 代码块（fence / 缩进代码）里的示例代码不算真视频块，跳过
      var inCode = t === 'code' || t === 'fence';
      if (!inCode && isVideoContainer(txt)) {
        var j = i;
        while (j < lines.length && !isVideoEnd(textOf(lines[j]))) j++;
        if (j < lines.length) {
          for (var k = i; k <= j; k++) lines[k].setAttribute('data-vblock', '1');
          lines[i].setAttribute('data-vhead', '1');
          i = j + 1;
          continue;
        }
      } else if (!inCode && hasVideoIframe(txt)) {
        lines[i].setAttribute('data-vblock', '1');
        lines[i].setAttribute('data-vhead', '1');
      }
      i++;
    }
  }

  /** 从视频块里解析出第一个 iframe 地址（哔哩哔哩优先，便于国内直接预览） */
  function resolveVideoSrc(lineEl) {
    var buf = [];
    var n = lineEl;
    var multi = isVideoContainer(textOf(lineEl));
    while (n) {
      buf.push(textOf(n));
      if (multi ? isVideoEnd(textOf(n)) : true) break;
      n = n.nextElementSibling;
    }
    var all = buf.join('\n');
    var m = /player\.bilibili\.com\/player\.html[^"'\s]*/.exec(all);
    if (m) return 'https://' + m[0];
    m = /youtube\.com\/embed\/[^"'\s]+/.exec(all);
    if (m) return 'https://www.' + m[0];
    return '';
  }

  /** 视频块首行渲染：原文留在隐藏 span（保证 textContent 不变），另配一个 iframe 预览 */
  function renderVideoPreview(lineEl, raw) {
    lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: raw }));
    var src = resolveVideoSrc(lineEl);
    if (src) {
      var wrap = el('div', { class: 'ed-video' });
      wrap.appendChild(el('iframe', {
        src: src,
        frameborder: '0',
        scrolling: 'no',
        allowfullscreen: 'true',
        title: '视频播放器预览'
      }));
      lineEl.appendChild(wrap);
    } else {
      lineEl.appendChild(el('span', { class: 'ed-video-badge', text: '▶ 视频播放器' }));
    }
  }

  /** 光标进/出视频块时折叠/展开：折叠态只显示首行 iframe，展开态显示全部源码 */
  function updateVideoBlockState(line) {
    var inBlock = !!(line && line.getAttribute && line.hasAttribute('data-vblock'));
    if (bodyEl.classList.contains('vblock-open') === inBlock) return;
    bodyEl.classList.toggle('vblock-open', inBlock);
    lineEls().forEach(function (l) {
      if (l.hasAttribute('data-vhead') && l !== activeLine) decorateLine(l);
    });
  }

  /**
   * 行内渲染。关键约束：渲染出来的 DOM 的 textContent 必须和原始 markdown
   * 一字不差 —— 标记（`**`、`[`、`](url)` …）都保留成被 CSS 隐藏的 span，
   * 所以 bodyText() 读回来还是原始文本，存盘不会丢字符。
   */
  function pushInline(box, text) {
    function mk(s) { if (s) box.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: s })); }
    function span(kind, s) { box.appendChild(el('span', { class: 'ed-i', 'data-i': kind, text: s })); }
    INLINE_RE.lastIndex = 0;
    var last = 0, m;
    while ((m = INLINE_RE.exec(text))) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) { mk('`'); span('code', m[1].slice(1, -1)); mk('`'); }
      else if (m[2]) { mk('**'); span('b', m[2]); mk('**'); }
      else if (m[3]) { mk('__'); span('b', m[3]); mk('__'); }
      else if (m[4]) { mk('~~'); span('s', m[4]); mk('~~'); }
      else if (m[5]) { mk('*'); span('i', m[5]); mk('*'); }
      else if (m[6] != null) {
        // alt 文本用 <span> 留住（textContent 必须一字不差），真图另配一个 <img>：
        // <img> 的 textContent 是空串，不影响读回原文
        mk('!['); span('img', m[6]); mk('](' + m[7] + ')');
        box.appendChild(imgNode(m[7]));
      }
      else if (m[8] != null) { mk('['); span('a', m[8]); mk('](' + m[9] + ')'); }
      last = m.index + m[0].length;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
  }

  /** 整行只有一张图片？→ 走大图预览 */
  var IMG_ONLY_RE = /^!\[[^\]\n]*\]\([^)\n]*\)$/;

  /** 把一行渲染成「去标记」的样子（光标不在这一行时才调用） */
  function decorateLine(lineEl) {
    if (!lineEl) return;
    var raw = textOf(lineEl);
    var t = lineEl.getAttribute('data-t') || 'p';
    lineEl.classList.remove('editing');
    lineEl.textContent = '';
    lineEl.classList.remove('img-only');
    if (t === 'table') { renderTableLine(lineEl, raw); return; }
    // 视频块首行：折叠态渲染 iframe 预览；展开态（光标在块内）显示源码
    if (lineEl.hasAttribute('data-vhead') && !bodyEl.classList.contains('vblock-open')) {
      renderVideoPreview(lineEl, raw);
      return;
    }
    var text = raw;
    var marker = '', m;
    if (t.charAt(0) === 'h' && (m = LINE_RE.atx.exec(text))) { marker = m[0]; text = text.slice(m[0].length); }
    else if (t === 'quote' && (m = LINE_RE.quote.exec(text))) { marker = m[0]; text = text.slice(m[0].length); }
    else if ((t === 'ul' || t === 'task' || t === 'task-done') && (m = LINE_RE.task.exec(text) || LINE_RE.ul.exec(text))) {
      marker = m[0]; text = text.slice(m[0].length);
    }
    if (marker) lineEl.appendChild(el('span', { class: 'ed-i', 'data-i': 'mk', text: marker }));
    // 代码块/HTML 行不做行内渲染（避免把里面的反引号、星号当成格式）
    if (t === 'code' || t === 'fence' || t === 'html' || t === 'hr') {
      lineEl.appendChild(document.createTextNode(text));
    } else {
      if (IMG_ONLY_RE.test(text.trim())) lineEl.classList.add('img-only');
      pushInline(lineEl, text);
      hydrateImages(lineEl);
    }
  }

  function decorateAll() {
    refreshVideoBlocks();
    lineEls().forEach(function (l) {
      if (l !== activeLine) decorateLine(l);
    });
  }

  function refreshTypes() {
    var st = { inFence: false };
    lineEls().forEach(function (l) {
      var t = lineType(textOf(l), st);
      if (l.getAttribute('data-t') !== t) l.setAttribute('data-t', t);
    });
  }

  /** 光标行保持原文；换行时把上一行还原成渲染态 */
  function syncActiveLine() {
    if (!bodyEl) return;
    var info = selInfo();
    if (!info) return;
    // 非折叠选区（正在拖选文字）期间不做任何 DOM 手术：
    // activeLine 切换 + textContent 重建会销毁选区所在的文本节点，
    // 打断浏览器原生拖选 —— 表现就是「从下往上选不动」（anchor 在下时
    // info.a 是文档起点、落在上方行，反复触发重建），从上往下却正常。
    // 只有纯光标（折叠选区）才需要把所在行切回源码态。
    if (info.a !== info.b) { lastAbs = info.a; return; }
    var loc = locate(info.a);
    if (!loc) { lastAbs = info.a; return; }
    updateVideoBlockState(loc.el);   // 光标进/出视频块时折叠/展开
    if (loc.el === activeLine) { lastAbs = info.a; return; }
    var abs = info.a, end = info.b;
    var prev = activeLine;
    activeLine = loc.el;
    if (prev) decorateLine(prev);
    activeLine.classList.add('editing');
    activeLine.textContent = textOf(activeLine);   // 去掉装饰，回到原始 markdown
    setCaret(abs, end > abs ? end : undefined);
  }

  function renderBody(text, caretA, caretB) {
    if (!bodyEl) return;
    suppress = true;
    bodyEl.innerHTML = '';
    var st = { inFence: false };
    String(text == null ? '' : text).split('\n').forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'cl';
      d.setAttribute('data-t', lineType(t, st));
      d.textContent = t;
      bodyEl.appendChild(d);
    });
    activeLine = null;
    suppress = false;
    decorateAll();
    if (caretA != null) { setCaret(caretA, caretB); syncActiveLine(); }
    else { lastAbs = bodyText().length; }
  }

  /* ---------------- 历史（自建撤销栈） ---------------- */
  function snap() {
    var info = selInfo();
    return { text: bodyText(), a: info ? info.a : lastAbs };
  }

  function pushHistory() {
    if (!bodyEl || !state.current) return;
    var s = snap();
    if (hist[histIdx] && hist[histIdx].text === s.text) return;
    hist = hist.slice(0, histIdx + 1);
    hist.push(s);
    if (hist.length > 120) { hist.shift(); }
    histIdx = hist.length - 1;
  }

  function jumpHistory(dir) {
    scheduleHistory.cancel();
    if (hist[histIdx] && hist[histIdx].text !== bodyText()) {
      pushHistory();
      if (dir > 0) return;
    }
    var next = histIdx + dir;
    if (next < 0 || next >= hist.length) return;
    histIdx = next;
    keepHistory = true;
    renderBody(hist[histIdx].text, hist[histIdx].a);
    onBodyInput();
    keepHistory = false;
  }

  /* ---------------- 文本操作（都基于绝对偏移） ---------------- */
  function applyText(next, selA, selB) {
    renderBody(next, selA, selB);
    onBodyInput();
  }

  function replaceSel(text, selA, selB) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var next = v.slice(0, info.a) + text + v.slice(info.b);
    var caret = info.a + text.length;
    applyText(next,
      selA != null ? selA : caret,
      selB != null ? selB : (selA != null ? selA : caret));
  }

  function insertText(text, selectOffset) {
    replaceSel(text,
      selectOffset ? selectOffset[0] : null,
      selectOffset ? selectOffset[1] : null);
  }

  /** 用 before/after 包裹选区 */
  function wrap(before, after, placeholder) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var sel = v.slice(info.a, info.b) || placeholder || '';
    var start = info.a + before.length;
    var next = v.slice(0, info.a) + before + sel + after + v.slice(info.b);
    applyText(next, start, start + sel.length);
  }

  /** 给选中的每一行加前缀 */
  function prefixLines(prefix, numbered) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var lineStart = v.lastIndexOf('\n', info.a - 1) + 1;
    var lineEnd = v.indexOf('\n', info.b);
    if (lineEnd === -1) lineEnd = v.length;
    var out = v.slice(lineStart, lineEnd).split('\n').map(function (line, i) {
      var p = numbered ? (i + 1) + '. ' : prefix;
      if (line.indexOf(p) === 0) return line; // 已经有前缀 → 不改
      return p + line;
    }).join('\n');
    var next = v.slice(0, lineStart) + out + v.slice(lineEnd);
    applyText(next, lineStart, lineStart + out.length);
  }

  /**
   * 在独立行插入块级内容（不吞掉已有选区，插到选区末尾所在行）
   * caretAfter=true → 光标落到插入内容之后的那一行，让块（表格/图片）
   * 立刻进入渲染态，不用先点别处才看得见效果
   */
  function insertBlock(text, caretAfter) {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var s = info.b;
    var lineStart = v.lastIndexOf('\n', s - 1) + 1;
    var needBefore = lineStart !== s && s !== 0 ? '\n' : '';
    var rest = v.slice(s);
    var needAfter = rest === '' || rest.charAt(0) !== '\n' ? '\n' : '';
    var payload = needBefore + text + needAfter;
    var next = v.slice(0, s) + payload + v.slice(s);
    var start = s + needBefore.length;
    if (!caretAfter) { applyText(next, start, start + text.length); return; }
    var after = s + payload.length;
    if (next.charAt(after) === '\n') after += 1;
    applyText(next, after);
  }

  var TABLE_TPL = '| 列 1 | 列 2 | 列 3 |\n|:---|:---:|---:|\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |';

  function action(name) {
    if (state.readOnly) { toast('main 分支只读，请先创建草稿', 'err'); return; }
    var ta = form.body;
    switch (name) {
      case 'bold': return wrap('**', '**', '加粗文字');
      case 'italic': return wrap('*', '*', '斜体文字');
      case 'strike': return wrap('~~', '~~', '删除线');
      case 'inline-code': return wrap('`', '`', 'code');
      case 'mark': return colorDialog();
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return prefixLines('#'.repeat(Number(name.slice(1))) + ' ');
      case 'ul': return prefixLines('- ');
      case 'ol': return prefixLines('', true);
      case 'task': return prefixLines('- [ ] ');
      case 'quote': return prefixLines('> ');
      case 'link': return wrap('[', '](https://)', '链接文字');
      case 'image': return pickBodyImage();
      case 'table': return insertBlock(TABLE_TPL, true);
      case 'code': return codeDialog();
      case 'hr': return insertBlock('---');
      case 'more': return insertBlock('<!-- more -->');
      case 'footnote': return footnote();
      case 'kbd': return wrap('<kbd>', '</kbd>', 'Ctrl');
      case 'sup': return wrap('<sup>', '</sup>', '1');
      case 'sub': return wrap('<sub>', '</sub>', '2');
      case 'center': return wrap('<div align="center">\n\n', '\n\n</div>', '居中内容');
      case 'details': return wrap('<details>\n<summary>展开查看</summary>\n\n', '\n\n</details>', '折叠内容');
      case 'bilibili': return videoDialog();
      case 'undo': return jumpHistory(-1);
      case 'redo': return jumpHistory(1);
      default: return;
    }
  }

  function colorDialog() {
    var chosen = 'red';
    var wrapEl = el('div');
    var colors = ['red', 'orange', 'green', 'blue', 'purple', 'gray'];
    var row = el('div', { class: 'seg' });
    colors.forEach(function (c) {
      var b = el('button', {
        type: 'button', text: c,
        style: 'color:' + c,
        onclick: function () { chosen = c; Array.from(row.children).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); }
      });
      if (c === chosen) b.classList.add('on');
      row.appendChild(b);
    });
    wrapEl.appendChild(row);
    wrapEl.appendChild(el('p', { class: 'tip', html: '生成：<code>&lt;font color="red"&gt;文字&lt;/font&gt;</code>（与现有文章的写法一致）' }));
    openModal({
      title: '文字颜色',
      body: wrapEl,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () { wrap('<font color="' + chosen + '">', '</font>', '文字'); } }
      ]
    });
  }

  function codeDialog() {
    var wrapEl = el('label', { class: 'field' }, [
      el('span', { class: 'lbl', text: '语言（可留空）' }),
      el('input', { type: 'text', placeholder: 'js / html / bash / yaml …' })
    ]);
    var input = wrapEl.querySelector('input');
    openModal({
      title: '插入代码块',
      body: wrapEl,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () {
          var lang = input.value.trim();
          var ta = form.body;
          var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'code';
          insertBlock('```' + lang + '\n' + sel + '\n```');
        } }
      ]
    });
  }

  function footnote() {
    var info = selInfo() || { a: lastAbs, b: lastAbs };
    var v = bodyText();
    var sel = v.slice(info.a, info.b) || '脚注内容';
    var used = new Set(v.match(/\[\^\d+\]/g) || []);
    var n = 1;
    while (used.has('[^' + n + ']')) n++;
    wrap('[^' + n + ']', '', '');
    insertBlock('[^' + n + ']: ' + sel);
  }

  /** 从本地选一张图 → 上传到当前草稿分支 → 插入 markdown */
  async function pickBodyImage() {
    var owner = state.current;
    var input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    document.body.appendChild(input);
    input.onchange = async function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      var path = await importImage(file);
      if (!path || state.current !== owner) return;
      // 光标落到图片行之后 → 这一行立即变成渲染态，图片马上看得见
      insertBlock('![](' + path + ')', true);
    };
    input.click();
  }

  /** 哔哩哔哩 / YouTube 播放器块 */
  function videoDialog() {
    var box = el('div');
    var fields = {};
    function mkField(key, label, ph) {
      var f = el('label', { class: 'field' }, [
        el('span', { class: 'lbl', text: label }),
        el('input', { type: 'text', placeholder: ph || '' })
      ]);
      fields[key] = f.querySelector('input');
      box.appendChild(f);
    }
    mkField('bvid', '哔哩哔哩', 'BV1CibC6BEdT 或 https://www.bilibili.com/video/BV…/');
    mkField('youtube', 'YouTube', 'bI5YOkr5-Lc 或 https://youtu.be/…');

    // 判断网络自动选择开关（默认勾选）
    var autoChk = el('input', { type: 'checkbox' });
    autoChk.checked = true;
    box.appendChild(el('label', { class: 'chk' }, [
      autoChk,
      el('span', { text: '判断网络，自动选择哔哩哔哩 / YouTube' })
    ]));
    var autoHint = el('p', { class: 'tip' });
    box.appendChild(autoHint);
    function refreshAutoHint() {
      autoHint.innerHTML = autoChk.checked
        ? '勾选后：<b>哔哩哔哩和 YouTube 都要填</b>。发布后播放器会用 <code>checkGoogle()</code> 判断访客网络，' +
          '能访问 YouTube 就加载 YouTube，否则加载哔哩哔哩 —— 与站内 23 篇文章的写法一致。'
        : '未勾选：只需填 <b>其中一个</b>，播放器固定加载你填的那个平台，不判断网络。';
    }
    autoChk.addEventListener('change', refreshAutoHint);
    refreshAutoHint();

    var styleRow = el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '样式' }),
      el('div', { class: 'seg' }, [
        el('button', { type: 'button', class: 'on', text: '等比 16:9（多数文章）', onclick: function (e) { pickStyle('padded', e.target); } }),
        el('button', { type: 'button', text: '固定高 450', onclick: function (e) { pickStyle('simple', e.target); } })
      ])
    ]);
    var style = 'padded';
    function pickStyle(v, btn) {
      style = v;
      Array.from(btn.parentNode.children).forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
    }
    box.appendChild(styleRow);
    var quoteChk = el('input', { type: 'checkbox' });
    box.appendChild(el('label', { class: 'chk' }, [quoteChk, el('span', { text: '同时追加以 “> 视频” 开头的引用链接' })]));

    openModal({
      title: '插入视频播放器块',
      body: box,
      actions: [
        { label: '取消', value: null },
        { label: '插入', primary: true, onClick: function () {
          var bili = Core.normalizeBilibiliId(fields.bvid.value);
          var bvid = bili.bvid;
          var yt = Core.normalizeYoutubeId(fields.youtube.value);
          var auto = autoChk.checked;

          if (auto) {
            if (!bvid || !yt) {
              toast('自动选择模式：哔哩哔哩和 YouTube 都必须填写', 'err');
              return false;
            }
          } else if (!bvid && !yt) {
            toast('至少填一个平台（哔哩哔哩或 YouTube）', 'err');
            return false;
          }

          var block = Core.buildVideoBlock({
            bvid: bvid,
            youtube: yt,
            style: style,
            auto: auto,
            includeQuote: quoteChk.checked,
            bilibiliUrl: bvid ? 'https://www.bilibili.com/video/' + bvid + '/' : '',
            youtubeUrl: yt ? 'https://youtu.be/' + yt : ''
          });
          insertBlock(block);
        } }
      ]
    });
  }

  function updateStats() {
    var v = bodyText();
    if (!v) {
      $('#stat').textContent = '0 字符';
      return;
    }
    var cjk = (v.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (v.match(/[A-Za-z0-9_]+/g) || []).length;
    var lines = v.split('\n').length;
    var minutes = Math.max(1, Math.round((cjk + words) / 400));
    $('#stat').textContent = v.length + ' 字符 · ' + lines + ' 行 · ' + (cjk + words) + ' 字 · 约 ' + minutes + ' 分钟';
  }

  function updateCursor() {
    var info = selInfo();
    var abs = info ? info.a : lastAbs;
    var upto = bodyText().slice(0, abs);
    var line = upto.split('\n').length;
    var col = upto.length - upto.lastIndexOf('\n');
    $('#cursor-info').textContent = '第 ' + line + ' 行，第 ' + col + ' 列';
  }

  /* ================================================================
   * 10. 正文输入
   * ================================================================ */
  var scheduleDraft = debounce(saveDraft, 800);
  var scheduleHistory = debounce(function () {
    if (!keepHistory) pushHistory();
  }, 450);

  function onBodyInput() {
    if (!state.current || suppress) return;
    // 兜底：某一行被塞进了换行（粘贴 / 输入法提交）→ 按行重排，光标跟着偏移走
    if (!composing && hasStrayNewline()) {
      var info0 = selInfo();
      renderBody(bodyText(), info0 ? info0.a : undefined);
    }
    refreshTypes();
    state.current.doc.body = bodyText();
    markDirty();
    updateStats();
    updateCursor();
    scheduleDraft();
    if (!keepHistory) scheduleHistory();
  }

  /* ---------------- 正文编辑行为（回车 / 退格 / 粘贴 / 组字） ---------------- */
  function nextPrefix(cur) {
    var m;
    if ((m = /^(\s{0,3})([-*+])\s+\[[ xX]\]\s+/.exec(cur))) return m[1] + m[2] + ' [ ] ';
    if ((m = /^(\s{0,3})([-*+])\s+/.exec(cur))) return m[1] + m[2] + ' ';
    if ((m = /^(\s{0,3})(\d+)([.)])\s+/.exec(cur))) return m[1] + (Number(m[2]) + 1) + m[3] + ' ';
    if ((m = /^(\s{0,3})>\s?/.exec(cur))) return m[1] + '> ';
    return '';
  }

  function eolOf(text, from) {
    var i = text.indexOf('\n', from);
    return i === -1 ? text.length : i;
  }

  function insertNewline() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var ls = text.lastIndexOf('\n', info.a - 1) + 1;
    var le = eolOf(text, info.a);
    var cur = text.slice(ls, le);
    var prefix = nextPrefix(cur);
    if (prefix && cur.trim() === prefix.trim()) {
      // 空的列表项：回车 = 退出列表（把这一行的标记去掉，光标留在行首）
      applyText(text.slice(0, ls) + text.slice(le), ls);
      return;
    }
    var payload = '\n' + prefix;
    applyText(text.slice(0, info.b) + payload + text.slice(info.b), info.b + payload.length);
  }

  function atLineStart() {
    var info = selInfo();
    if (!info || info.a !== info.b) return false;
    var text = bodyText();
    return text.lastIndexOf('\n', info.a - 1) === info.a - 1;
  }

  function atLineEnd() {
    var info = selInfo();
    if (!info || info.a !== info.b) return false;
    var text = bodyText();
    return info.a === text.length || text.charAt(info.a) === '\n';
  }

  function mergeUp() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var ls = text.lastIndexOf('\n', info.a - 1) + 1;
    if (ls === 0) return;
    var prevEnd = ls - 1;
    applyText(text.slice(0, prevEnd) + text.slice(ls), prevEnd);
  }

  function mergeDown() {
    var info = selInfo();
    if (!info) return;
    var text = bodyText();
    var le = eolOf(text, info.a);
    if (le === text.length) return;
    applyText(text.slice(0, le) + text.slice(le + 1), le);
  }

  function onBodyKeydown(e) {
    if (e.isComposing || composing) return;
    var mod = e.ctrlKey || e.metaKey;
    var k = (e.key || '').toLowerCase();
    if (mod && !e.shiftKey && k === 'z') { e.preventDefault(); jumpHistory(-1); return; }
    if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); jumpHistory(1); return; }
    if (mod) return;
    if (e.key === 'Enter') { e.preventDefault(); insertNewline(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText('  '); return; }
    if (e.key === 'Backspace' && atLineStart()) { e.preventDefault(); mergeUp(); return; }
    if (e.key === 'Delete' && atLineEnd()) { e.preventDefault(); mergeDown(); return; }
  }

  function onBodyPaste(e) {
    if (!e.clipboardData) return;
    e.preventDefault();
    var t = e.clipboardData.getData('text/plain');
    if (t) insertText(String(t).replace(/\r\n?/g, '\n'));
  }

  /**
   * 点表格单元格 / 整行图片时，把光标放到对应的源码位置。
   * 这两类都是「渲染态只是一层皮」，直接让浏览器放光标会飘到行首，
   * 所以自己算绝对偏移：点第几个单元格就落在第几个单元格的文字上。
   */
  function onBodyMouseDown(e) {
    if (!bodyEl || !state.current) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var cell = t.closest('.tc');
    var img = t.closest('img.ed-img');
    if (!cell && !img) return;
    e.preventDefault();
    var line = (cell || img).parentElement;
    var lines = lineEls();
    var idx = lines.indexOf(line);
    if (idx < 0) return;
    var base = 0;
    for (var i = 0; i < idx; i++) base += textOf(lines[i]).length + 1;
    var at = cell ? (Number(cell.getAttribute('data-at')) || 0) : textOf(line).length;
    setCaret(base + at);
    syncActiveLine();
    updateCursor();
  }

  function onSelChange() {
    if (suppress || !bodyEl || !state.current) return;
    var s = window.getSelection();
    if (!s || !s.rangeCount) return;
    if (!bodyEl.contains(s.anchorNode)) return;
    syncActiveLine();
    updateCursor();
  }

  /* ================================================================
   * 11. 草稿（localStorage）
   * ================================================================ */
  function draftPrefix() { return 'hexo-editor:draft:v2:' + state.projectId + ':'; }
  function draftKey(p) {
    return 'hexo-editor:draft:v2:' + (p.projectId || state.projectId) + ':' + p.path;
  }

  function saveDraft(p) {
    p = p || state.current;
    if (!p || !p.dirty) return false;
    try {
      p.projectId = p.projectId || state.projectId;
      if (state.current === p) p.pendingName = form.fileName.value;
      localStorage.setItem(draftKey(p), JSON.stringify({
        at: Date.now(),
        text: Core.stringifyPost(p.doc),
        path: p.path,
        name: p.name,
        pendingName: p.pendingName,
        isNew: !!p.isNew,
        savedOnce: !!p.savedOnce,
        baseRaw: p.raw
      }));
      return true;
    } catch (e) { return false; }  // 配额错误等：本地暂存失败，提示里不能说「已暂存」
  }

  function clearDraft(p) {
    try { localStorage.removeItem(draftKey(p)); } catch (e) {}
  }

  function commitCurrentDraft() {
    if (state.current && state.current.dirty) saveDraft();
  }

  /** 没有磁盘文件的新稿也必须出现在文章列表中。 */
  function discoverDrafts() {
    try {
      var prefix = draftPrefix();
      Object.keys(localStorage).forEach(function (key) {
        if (key.indexOf(prefix) !== 0) return;
        var path = key.slice(prefix.length);
        if (state.posts.some(function (p) { return p.path === path; })) return;
        var saved = JSON.parse(localStorage.getItem(key));
        if (!saved || typeof saved.text !== 'string') return;
        var parts = pathParts(path);
        state.posts.push({
          id: uid(), path: path, name: parts[parts.length - 1], projectId: state.projectId,
          pendingName: saved.pendingName,
          doc: Core.parsePost(saved.text, { isNew: true }), raw: saved.baseRaw || '',
          handle: null, dirty: true, savedOnce: false, isNew: true
        });
      });
    } catch (e) { /* 不可用的存储不能阻止读盘 */ }
  }

  async function checkDraft(p) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(draftKey(p)) || 'null'); } catch (e) {}
    if (!saved || !saved.text) return;
    if (saved.text === p.raw && (!saved.pendingName || saved.pendingName === p.name)) { clearDraft(p); return; }
    var choice = await openModal({
      title: '发现未保存的草稿',
      body: '<p class="tip">这篇文章有一份本地草稿（' + new Date(saved.at).toLocaleString() +
        '）。要恢复吗？</p>' + (saved.pendingName && saved.pendingName !== p.name
          ? '<p>待保存文件名：<code>' + escapeHtml(saved.pendingName) + '</code></p>' : '') +
        '<p class="tip">草稿内容：<br><code>' +
        escapeHtml(saved.text.slice(0, 260)) + (saved.text.length > 260 ? '…' : '') + '</code></p>',
      actions: [
        { label: '用远端版本', value: 'discard' },
        { label: '恢复草稿', primary: true, value: 'restore' }
      ]
    });
    if (state.current !== p) return;
    if (choice === 'restore') {
      if (saved.isNew === true) { p.isNew = true; p.savedOnce = false; }
      p.doc = Core.parsePost(saved.text, { isNew: p.isNew });
      p.pendingName = saved.pendingName || p.pendingName;
      var keepDirty = true;
      openPost(p, { keepDirty: keepDirty, skipDraftCheck: true, skipDraftCommit: true });
      toast('已恢复草稿，记得保存', 'ok');
    } else if (choice === 'discard') {
      clearDraft(p);
      if (p.isNew && !p.raw) {
        state.posts = state.posts.filter(function (x) { return x !== p; });
        p.dirty = false;
        if (state.current === p) closeEditor();
      } else {
        p.doc = Core.parsePost(p.raw);
        p.isNew = false;
        p.savedOnce = true;
        p.dirty = false;
        p.pendingName = null;
        if (state.current === p) openPost(p, { skipDraftCheck: true, skipDraftCommit: true });
      }
    }
  }

  /* ================================================================
   * 12. 保存 / 新建 / 删除
   * ================================================================ */
  function currentText() {
    return Core.stringifyPost(state.current.doc);
  }

  /** 项目里已被占用的 abbrlink（小写）；空值按 crc32(标题) 折算 */
  function usedAbbrlinks(except) {
    var set = new Set();
    (state.posts || []).forEach(function (p) {
      if (!p || p === except) return;
      var v = String(Core.get(p.doc, 'abbrlink') || '').trim().toLowerCase();
      if (!v) v = String(Core.predictAbbrlink(Core.get(p.doc, 'title')) || '').toLowerCase();
      if (v) set.add(v);
    });
    return set;
  }

  /** 确保文章有 abbrlink：已有值不动，缺失时按标题分配 */
  function ensureAbbrlink(p) {
    if (!p) return '';
    var cur = String(Core.get(p.doc, 'abbrlink') || '').trim();
    if (cur) return cur;
    var title = String(Core.get(p.doc, 'title') || '').trim();
    if (!title) return '';
    var v = Core.allocateAbbrlink(title, usedAbbrlinks(p));
    if (v) {
      Core.set(p.doc, 'abbrlink', v);
      if (state.current === p) form.abbrlink.value = v;
    }
    return v;
  }

  async function savePost(opts) {
    opts = opts || {};
    var source = state.current;
    if (!source || source.saving) return;
    if (state.readOnly) { toast('main 分支只读，请先点「编辑」创建草稿', 'err'); return; }
    ensureAbbrlink(source);
    var issues = validateAndShow();
    var errors = (issues || []).filter(function (i) { return i.level === 'error'; });
    if (errors.length && !opts.force) {
      // 只报第一条（完整列表已经在字段下方常驻显示），并把焦点带过去，
      // 避免用户点了保存毫无反应、不知道哪里出了问题。
      toast('无法保存：' + errors[0].message, 'err');
      var fld = document.querySelector('.field.invalid input, .field.invalid textarea, input.invalid');
      if (fld) fld.focus();
      return;
    }

    return saveGitHubDraft(source, opts);
  }

  function unusedName(name) {
    var base = name.replace(/\.md$/i, ''), candidate = name, n = 2;
    while (state.posts.some(function (p) { return p.name === candidate; })) candidate = base + ' (' + (n++) + ').md';
    return candidate;
  }  async function newPost() {
    return newGitHubPost();
  }

  /**
   * GitHub 模式删除：
   * - 从没发布过的草稿 → 直接删分支，不产生部署；
   * - 已发布的文章 → 在草稿分支里删掉文件，发布后才真正消失，可撤销。
   */
  async function deleteGitHubPost() {
    var p = state.current;
    if (!p || !p.github) return false;
    if (p.saving) return false;
    if (p.removed) return undoGitHubDelete();

    if (!p.mainExists) {
      var del = await openModal({
        title: '删除草稿',
        body: '<p class="tip">这篇草稿还没发布过。删除会丢弃草稿分支 <code>' +
          escapeHtml(p.draft ? p.draft.branch : '(未保存)') + '</code>，网站不受影响，也不产生部署。</p>',
        actions: [{ label: '取消', value: null }, { label: '删除草稿', primary: true, danger: true, value: true }]
      });
      if (!del) return false;
      showBusy('正在删除草稿…');
      try {
        if (p.draft) await GitHubStore.deleteRef(p.draft.branch).catch(function () { /* 忽略 */ });
        if (p.draft) state.selected.delete(p.draft.branch);
        state.posts = state.posts.filter(function (x) { return x !== p; });
        clearDraft(p);
        if (state.current === p) closeEditor();
        reindex();
        toast('草稿已删除', 'ok');
        return true;
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
        return false;
      } finally {
        hideBusy();
      }
    }

    var abbr = String(Core.get(p.doc, 'abbrlink') || '').trim().toLowerCase();
    var branch = p.draft ? p.draft.branch : (abbr ? 'draft/' + abbr : '');
    if (!branch) { toast('这篇文章没有 abbrlink，无法建立草稿分支', 'err'); return false; }
    var ok = await openModal({
      title: '删除文章',
      body: '<p class="tip">会把 <code>' + escapeHtml(p.name) + '</code> 从草稿分支 <code>' +
        escapeHtml(branch) + '</code> 里删除。<b>发布到网站后才会真正消失</b>，发布前可以撤销。</p>',
      actions: [{ label: '取消', value: null }, { label: '删除', primary: true, danger: true, value: true }]
    });
    if (!ok) return false;

    showBusy('正在标记为待删除…');
    var step = '检查草稿分支';
    try {
      var head = await GitHubStore.findRef(branch);
      var base = p.draft && p.draft.base ? p.draft.base : null;
      var entries = [{ path: p.path, mode: '100644', type: 'blob', sha: null }];
      var commitSha;
      if (head) {
        step = '更新草稿提交';
        setBusyText('待删除：' + step);
        var hc = await GitHubStore.getCommit(head);
        if (!base) base = (hc.parents && hc.parents[0] && hc.parents[0].sha) || null;
        var tree = await GitHubStore.createTree(hc.tree.sha, entries);
        var c = await GitHubStore.createCommit('draft: 删除 ' + postTitle(p), tree, [head]);
        await GitHubStore.updateRef(branch, c.sha, false);
        commitSha = c.sha;
      } else {
        step = '创建草稿分支';
        setBusyText('待删除：' + step);
        var mainSha = await GitHubStore.headSha('main');
        base = mainSha;
        var mc = await GitHubStore.getCommit(mainSha);
        var t2 = await GitHubStore.createTree(mc.tree.sha, entries);
        var c2 = await GitHubStore.createCommit('draft: 删除 ' + postTitle(p), t2, [mainSha]);
        await GitHubStore.createRef(branch, c2.sha);
        commitSha = c2.sha;
      }

      p.draft = { branch: branch, base: base, head: commitSha };
      p.removed = true;
      p.readOnly = true;
      p.editing = false;
      p.dirty = false;
      clearDraft(p);
      updateDirtyUI();
      applyReadOnly();
      renderList();
      toast('已标记为待删除，发布后才会从网站消失', 'ok');
      return true;
    } catch (e) {
      console.error('[删除]', e && e.request, e);
      toast('删除失败（' + step + '）：' + e.message, 'err');
      return false;
    } finally {
      hideBusy();
    }
  }

  /** 撤销待删除：把 main 上的原文恢复到草稿分支 */
  async function undoGitHubDelete() {
    var p = state.current;
    if (!p || !p.removed || !p.draft) return false;
    showBusy('正在撤销删除…');
    try {
      var data = await GitHubStore.readPost(p.path, 'main');
      var blob = await GitHubStore.createBlob(data.text);
      var head = await GitHubStore.branchHead(p.draft.branch);
      var hc = await GitHubStore.getCommit(head);
      var tree = await GitHubStore.createTree(hc.tree.sha, [
        { path: p.path, mode: '100644', type: 'blob', sha: blob }
      ]);
      var commit = await GitHubStore.createCommit('draft: 恢复 ' + postTitle(p), tree, [head]);
      await GitHubStore.updateRef(p.draft.branch, commit.sha, false);

      // 恢复后如果和 main 完全一致，草稿分支就没有存在意义了
      var diff = await GitHubStore.compare('main', commit.sha);
      if (!((diff && diff.files) || []).length) {
        await GitHubStore.deleteRef(p.draft.branch).catch(function () { /* 忽略 */ });
        state.selected.delete(p.draft.branch);
        p.draft = null;
      } else {
        p.draft.head = commit.sha;
      }
      p.removed = false;
      p.readOnly = true;
      p.editing = false;
      applyReadOnly();
      renderList();
      toast('已撤销删除', 'ok');
      return true;
    } catch (e) {
      console.error('[撤销删除]', e && e.request, e);
      toast('撤销失败：' + e.message, 'err');
      return false;
    } finally {
      hideBusy();
    }
  }

  async function deletePost() {
    return deleteGitHubPost();
  }

  function updateModeUI() {
    renderGitHubStatus();
    renderDraftBar();
    var imgBtn = $('#btn-images');
    if (imgBtn) imgBtn.classList.toggle('hidden', state.mode !== 'github');
    refreshMainView();
  }

  /** 主区三种状态：未连目录→欢迎页；连了但没选文章→灰掉的编辑器；选了→正常编辑 */
  function refreshMainView() {
    var connected = state.posts.length > 0;
    var idle = connected && !state.current;

    $('#empty').classList.toggle('hidden', connected);
    $('#editor').classList.toggle('hidden', !connected);
    $('#editor').classList.toggle('idle', idle);
    $('#idle-hint').classList.toggle('hidden', !idle);

    var body = $('#editor').querySelector('.ed-body');
    if (body && 'inert' in body) body.inert = idle;

    // 空闲态：清空上次残留，文件名框禁用
    var fn = $('#file-name');
    if (fn) fn.disabled = idle;
    if (idle && form && form.title) {
      ['fileName', 'title', 'abbrlink', 'description', 'date', 'cover', 'body'].forEach(function (k) {
        if (form[k]) form[k].value = '';
      });
      if (form.tagsChips) form.tagsChips.innerHTML = '';
      if (form.tagsInput) form.tagsInput.value = '';
      updateCoverPreview();
    }

    // 只有打开文章后才出现「收起/展开列表」按钮；没有打开文章时列表一定展开
    $('#btn-toggle-sidebar').classList.toggle('hidden', !state.current);
    if (!state.current) state.sidebarCollapsed = false;
    applySidebar();
  }

  function applySidebar() {
    var app = $('#app');
    if (app) app.classList.toggle('collapsed', !!state.sidebarCollapsed && !!state.current);
  }

  function toggleSidebar() {
    if (!state.current) return;      // 没选文章时不允许收起
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applySidebar();
  }

  /** 列表底部：GitHub 连接状态（现在只有这一种工作方式） */
  function renderGitHubStatus() {
    var gh = $('#dot-github');
    if (!gh) return;
    var on = state.mode === 'github';
    gh.classList.toggle('on', on);
    var label = gh.querySelector('span');
    if (label) label.textContent = on ? ('GitHub · ' + state.posts.length + ' 篇') : 'GitHub';
    gh.title = on
      ? '已连接 ' + (state.githubRepo || '') + ' · main（点击查看）'
      : '未连接 GitHub（点击重试）';
  }

  /* ================================================================
   * 13.5 主题：白天 / 黑夜 / 自动（跟随系统）
   * ================================================================ */
  var THEME_KEY = 'hexo-editor:theme';

  function themeMode() {
    var m = 'auto';
    try { m = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* file:// 下可能被禁 */ }
    return ['light', 'dark', 'auto'].indexOf(m) === -1 ? 'auto' : m;
  }

  function systemDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  /** 把当前模式落到 html[data-theme] 上，并点亮对应的那个按钮 */
  function applyTheme() {
    var mode = themeMode();
    var effective = mode === 'auto' ? (systemDark() ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', effective);
    $$('#theme-switch button').forEach(function (b) {
      var on = b.getAttribute('data-theme') === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    return effective;
  }

  function setTheme(mode) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* 忽略 */ }
    return applyTheme();
  }

  /* ================================================================
   * 14. 绑定事件
   * ================================================================ */
  function bind() {
    cacheForm();

    /* --- 授权失败重试 / 登录过期提示 --- */
    var retryAuth = $('#btn-auth-retry');
    if (retryAuth) retryAuth.onclick = function () { if (window.GitHubStore) GitHubStore.login(); };
    var laterAuth = $('#btn-auth-later');
    if (laterAuth) laterAuth.onclick = hideAuthExpired;
    var reloginBtn = $('#btn-auth-relogin');
    if (reloginBtn) reloginBtn.onclick = relogin;
    window.addEventListener('hexo-editor:auth-expired', showAuthExpired);

    /* --- 左下角 GitHub 状态 --- */
    var dotGh = $('#dot-github');
    if (dotGh) dotGh.onclick = openGitHubInfo;

    /* --- 侧栏收起 / 展开 --- */
    $('#btn-toggle-sidebar').onclick = toggleSidebar;

    /* --- 主题：太阳 / 月亮 / 自动 --- */
    $$('#theme-switch button').forEach(function (b) {
      b.onclick = function () { setTheme(b.getAttribute('data-theme')); };
    });
    if (window.matchMedia) {
      try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onSystem = function () { if (themeMode() === 'auto') applyTheme(); };
        if (mq.addEventListener) mq.addEventListener('change', onSystem);
        else if (mq.addListener) mq.addListener(onSystem);
      } catch (e) { /* 忽略 */ }
    }

    /* --- 新建 / 刷新 --- */
    $('#btn-new').onclick = newPost;
    $('#btn-images').onclick = openImageManager;
    $('#btn-refresh').onclick = async function () {
      commitCurrentDraft();
      try { await refreshGitHub(); } catch (e) { toast('刷新失败：' + e.message, 'err'); }
    };

    /* --- 筛选 --- */
    $('#search').oninput = debounce(function (e) {
      state.filter.q = e.target.value.trim();
      renderList();
    }, 120);
    $('#sort').onchange = function (e) { state.filter.sort = e.target.value; renderList(); };
    $('#filter-dirty').onchange = function (e) { state.filter.dirtyOnly = e.target.checked; renderList(); };

    /* --- 属性字段 --- */
    form.title.oninput = function () {
      setField('title', form.title.value);
      var p = state.current;
      if (p && p.isNew && !String(Core.get(p.doc, 'abbrlink') || '').trim() && ensureAbbrlink(p)) {
        applyLocks();
      }
      renderFrontMatter();
    };
    form.description.oninput = function () { setField('description', form.description.value); };
    form.cover.oninput = function () {
      if (state.current) coverImports.delete(state.current);
      setField('cover', form.cover.value.trim());
      updateCoverPreview();
    };
    form.abbrlink.oninput = function () { setField('abbrlink', form.abbrlink.value.trim()); };
    form.date.oninput = function () {
      var v = form.date.value.trim();
      if (v && !Core.parseDate(v)) {
        // 格式暂不合法：标红提示，但不静默丢弃——原始输入照样写进 doc，
        // 保证「表单显示的」与「保存的」一致，不会出现「改了却没保存」的错觉。
        form.date.classList.add('invalid');
      } else {
        form.date.classList.remove('invalid');
      }
      setField('date', v);
    };
    form.date.onblur = function () {
      var v = form.date.value.trim();
      var d = Core.parseDate(v);
      if (d) {
        var normalized = Core.hasTimePart(v) ? Core.formatDateTime(d) : Core.formatDate(d);
        form.date.value = normalized;
        setField('date', normalized);
        form.date.classList.remove('invalid');
      }
      // 格式不合法时保留红框：输入还没被接受，不能把警告悄悄擦掉
    };

    /* --- 标签输入 --- */
    form.tagsInput.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        addTag(form.tagsInput.value);
      } else if (e.key === 'Backspace' && form.tagsInput.value === '') {
        var arr = Core.get(state.current.doc, 'tags') || [];
        if (arr.length) {
          arr = arr.slice(0, -1);
          setField('tags', arr);
          renderChips();
        }
      }
    };
    form.tagsInput.oninput = renderSuggest;
    form.tagsInput.onblur = function () {
      if (form.tagsInput.value.trim()) addTag(form.tagsInput.value);
    };

    /* --- abbrlink 重算 --- */
    $('#btn-regen-link').onclick = function (e) {
      e.preventDefault();
      var p = state.current;
      if (!p) return;
      var title = String(Core.get(p.doc, 'title') || '').trim();
      if (!title) { toast('先填写标题，再生成 abbrlink', 'err'); return; }
      var next = Core.allocateAbbrlink(title, usedAbbrlinks(p));
      var cur = String(Core.get(p.doc, 'abbrlink') || '').trim();
      if (cur && cur.toLowerCase() === next) { toast('当前 abbrlink 已是最新'); return; }
      openModal({
        title: '重新生成 abbrlink',
        body: '<p class="tip">按当前标题计算：<code>' + escapeHtml(next) + '</code></p>' +
          (cur
            ? '<p class="tip">当前值 <code>' + escapeHtml(cur) + '</code> 会被替换，<b>文章 URL 将改变</b>，已有外链会失效。</p>'
            : '<p class="tip">写入后 <code>hexo generate</code> 不会再改它。</p>'),
        actions: [
          { label: '取消', value: null },
          { label: '替换', primary: true, onClick: function () {
            form.abbrlink.value = next;
            setField('abbrlink', next);
            applyLocks();
            renderFrontMatter();
          } }
        ]
      });
    };
    $('#lock-date').onclick = function (e) {
      e.preventDefault();
      var p = state.current;
      if (!p) return;
      if (p.savedOnce) { toast('日期可直接编辑'); return; }
      toast('先保存文章，日期才会解锁', 'err');
    };

    /* --- 封面 --- */
    var coverImports = new WeakMap();
    async function applyCoverFile(file, owner) {
      if (!owner || state.current !== owner || !file || !/^image\//.test(file.type)) return;
      var ticket = {};
      coverImports.set(owner, ticket);
      var path = await importImage(file);
      if (!path || coverImports.get(owner) !== ticket || !state.posts.includes(owner)) return;
      if (state.current === owner) {
        form.cover.value = path;
        setField('cover', path);
        updateCoverPreview();
      } else {
        Core.set(owner.doc, 'cover', path);
        owner.dirty = true;
        saveDraft(owner);
        renderList();
      }
    }
    $('#btn-cover-pick').onclick = function () {
      var owner = state.current;
      var input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
      document.body.appendChild(input);
      input.onchange = async function () {
        var file = input.files && input.files[0];
        input.remove();
        await applyCoverFile(file, owner);
      };
      input.click();
    };
    $('#btn-cover-clear').onclick = function () {
      if (state.current) coverImports.delete(state.current);
      form.cover.value = '';
      setField('cover', '');
      updateCoverPreview();
    };
    $('#cover-preview').addEventListener('dragover', function (e) { e.preventDefault(); });
    $('#cover-preview').addEventListener('drop', async function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0; dropHint.classList.remove('on');
      await applyCoverFile(e.dataTransfer.files[0], state.current);
    });

    /* --- 属性区折叠 / front matter --- */
    $('#btn-mobile-props').onclick = function () {
      var shown = $('.ed-body').classList.toggle('mobile-props');
      this.setAttribute('aria-expanded', String(shown));
      this.textContent = shown ? '正文' : '属性';
    };
    $('#btn-props-toggle').onclick = function () {
      if (window.matchMedia && window.matchMedia('(max-width: 860px)').matches) {
        $('#btn-mobile-props').click(); return;
      }
      var body = $('.ed-body');
      body.classList.toggle('no-props');
      this.textContent = body.classList.contains('no-props') ? '展开' : '收起';
    };
    $('#btn-frontmatter').onclick = function () {
      var v = $('#frontmatter-view');
      v.classList.toggle('hidden');
      renderFrontMatter();
    };

    /* --- 保存 / 另存 / 复制 / 删除 --- */
    $('#btn-edit').onclick = function () { enterDraftMode(); };
    $('#btn-publish').onclick = function () { publishGitHubDraft(); };
    $('#btn-save').onclick = function () { savePost(); };
    $('#btn-delete').onclick = deletePost;
    $('#btn-undo-delete').onclick = undoGitHubDelete;
    $('#btn-select-all').onclick = toggleSelectAll;
    $('#btn-publish-selected').onclick = publishSelectedDrafts;

    /* --- 正文（contenteditable：自己接管输入行为） --- */
    form.body.addEventListener('input', onBodyInput);
    form.body.addEventListener('keydown', onBodyKeydown);
    form.body.addEventListener('paste', onBodyPaste);
    form.body.addEventListener('mousedown', onBodyMouseDown);
    form.body.addEventListener('compositionstart', function () { composing = true; });
    form.body.addEventListener('compositionend', function () {
      composing = false;
      refreshTypes();
      onBodyInput();
    });
    document.addEventListener('selectionchange', onSelChange);

    /* --- 工具栏（mousedown 阻止默认，避免正文选区丢失） --- */
    $('#toolbar').addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    $('#toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      action(btn.getAttribute('data-act'));
    });

    /* --- 文件名 --- */
    // 只标记「待改名」，不直接改 p.name —— p.name 始终代表仓库里真实的文件名
    form.fileName.onchange = function () {
      if (!state.current) return;
      var v = form.fileName.value.trim();
      if (v === state.current.name) {
        state.current.pendingName = null;
        if (!state.current.isNew && currentText() === state.current.raw) {
          state.current.dirty = false;
          clearDraft(state.current);
          renderList(); updateDirtyUI();
        } else if (state.current.dirty) saveDraft();
        return;
      }
      state.current.pendingName = v;
      markDirty();
    };

    /* --- 拖放图片 --- */
    var dropHint = $('#drop-hint');
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
      dragDepth += 1;
      dropHint.classList.add('on');
    });
    document.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropHint.classList.remove('on');
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', async function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropHint.classList.remove('on');
      var owner = state.current;
      if (!owner || !$('#md-pane').contains(e.target)) return;
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      var images = files.filter(function (f) { return /^image\//.test(f.type); });
      if (!images.length) return;
      for (var i = 0; i < images.length; i++) {
        var path = await importImage(images[i]);
        if (state.current !== owner) return;
        if (path) insertBlock('![](' + path + ')', true);
      }
    });

    /* --- 快捷键 --- */
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var k = e.key.toLowerCase();
      if (e.isComposing || composing || !$('#modal').classList.contains('hidden')) return;
      if (k === 's') { e.preventDefault(); savePost(); }
      else if (k === 'n' && e.shiftKey) { e.preventDefault(); newPost(); }
      else if (!bodyEl.contains(e.target) && e.target !== bodyEl) return;
      else if (k === 'b') { e.preventDefault(); action('bold'); }
      else if (k === 'i') { e.preventDefault(); action('italic'); }
      else if (k === 'k') { e.preventDefault(); action('link'); }
      else if (k === '2') { e.preventDefault(); action('h2'); }
      else if (k === '3') { e.preventDefault(); action('h3'); }
      else if (k === '4') { e.preventDefault(); action('h4'); }
    });

    window.addEventListener('beforeunload', function (e) {
      var dirty = state.posts.some(function (p) { return p.dirty; });
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ================================================================
   * 15. 启动
   * ================================================================ */
  async function boot() {
    bind();
    applyTheme();
    updateModeUI();

    // 本地目录模式已移除：双击打开只能看到一个提示，避免误以为还能写盘
    if (location.protocol === 'file:') {
      toast('本地模式已移除，请访问 https://zerokami.cn/tools/online-hexo-editor', 'err');
      state.booted = true;
      return;
    }

    // 现在只有 GitHub 模式：直接连接；未登录会跳到授权页
    if (window.GitHubStore) {
      // 回调失败：停在引导页给提示，绝不自动再跳授权（否则 401 → 授权 → 失败 → 401 死循环）
      var authError = readAuthError();
      if (authError) {
        showAuthError(authError);
        state.booted = true;
        return;
      }
      stripAuthOk();
      await enterGitHub();
    } else {
      toast('GitHub 模块未加载，无法进入在线编辑器', 'err');
    }
    updateModeUI();
    state.booted = true;
  }

  var bootStarted = false;
  document.addEventListener('DOMContentLoaded', function () {
    if (bootStarted) return;
    bootStarted = true;
    cacheForm();
    boot();
  });

  /* ================================================================
   * 16. 对外暴露（供测试与命令行调试使用）
   * ================================================================ */
  window.HexoEditor = {
    state: state,
    form: form,
    openPost: openPost,
    closeEditor: closeEditor,
    newPost: newPost,
    savePost: savePost,
    deletePost: deletePost,
    setField: setField,
    addTag: addTag,
    renderChips: renderChips,
    renderList: renderList,
    reindex: reindex,
    applyLocks: applyLocks,
    validateAndShow: validateAndShow,
    renderFrontMatter: renderFrontMatter,
    action: action,
    insertBlock: insertBlock,
    wrap: wrap,
    prefixLines: prefixLines,
    currentText: currentText,
    draftKey: draftKey,
    /* 正文（contenteditable）相关的测试钩子 */
    getBody: bodyText,
    setBody: function (text) {
      renderBody(text, 0);
      onBodyInput();
    },
    setSel: function (a, b) { bodyEl.focus(); setCaret(a, b); syncActiveLine(); updateCursor(); },
    selectAll: function () { bodyEl.focus(); setCaret(0, bodyText().length); syncActiveLine(); },
    getSel: function () { var i = selInfo(); return i || { a: lastAbs, b: lastAbs }; },
    lineTypes: function () { return lineEls().map(function (l) { return l.getAttribute('data-t'); }); },
    undo: function () { jumpHistory(-1); },
    redo: function () { jumpHistory(1); },
    historyPush: pushHistory,
    updateModeUI: updateModeUI,
    renderGitHubStatus: renderGitHubStatus,
    resolveImageUrl: resolveImageUrl,
    refreshMainView: refreshMainView,
    toggleSidebar: toggleSidebar,
    applyTheme: applyTheme,
    setTheme: setTheme,
    themeMode: themeMode,
    setMode: function (mode, list) {
      state.mode = mode;
      state.posts = list || [];
      state.current = null;
      reindex();
      updateModeUI();
    },
    /** 测试用：直接从内存里的 md 文本造一篇（不碰磁盘） */
    loadFromText: function (name, raw, opts) {
      opts = opts || {};
      var doc = Core.parsePost(raw, { isNew: !!opts.isNew });
      var p = {
        id: uid(), projectId: state.projectId, path: name, name: name, doc: doc, raw: raw, handle: null,
        dirty: !!opts.dirty, savedOnce: !opts.isNew, isNew: !!opts.isNew
      };
      state.posts.unshift(p);
      reindex();
      openPost(p, { skipDraftCheck: true });
      return p;
    }
  };
})();
