/*!
 * GitHub 存储层（在线版编辑器专用）
 * 所有请求走同域 /api/github/*，由 Netlify Function 代理并注入 token，
 * 浏览器不接触 GitHub 凭据。
 */
(function (root) {
  'use strict';

  var REPO = root.HEXO_EDITOR_REPO || 'XieYu-Zk/ZEROKAMI-STUDIO';
  var BASE = '/api/github/repos/' + REPO;
  var POSTS_DIR = 'source/_posts/';

  function url(path) {
    return BASE + path;
  }

  function request(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ accept: 'application/vnd.github+json' }, opts.headers || {}),
    };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(url(path), init).then(function (res) {
      var type = res.headers.get('content-type') || '';
      var parse = /json/.test(type) ? res.json().catch(function () { return null; }) : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function decodeBase64(b64) {
    var bin = atob(String(b64 || '').replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function encodeBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /** 登录入口：整页跳转，回调后回到编辑器 */
  function login(returnTo) {
    var back = returnTo || (location.pathname + location.search);
    try { sessionStorage.setItem('hexo-editor:return', back); } catch (e) { /* ignore */ }
    location.href = '/api/github/auth/start';
  }

  /** 是否已登录：能读到仓库信息就算通 */
  function status() {
    return request('').then(function (repo) {
      return {
        ok: true,
        repo: repo.full_name,
        branch: repo.default_branch,
        private: repo.private,
        canPush: !!(repo.permissions && repo.permissions.push),
      };
    }).catch(function (e) {
      return { ok: false, error: e.status || 0, message: e.message };
    });
  }

  /** 当前 main 的 commit sha */
  function headSha(branch) {
    return request('/git/ref/heads/' + (branch || 'main')).then(function (ref) {
      return ref.object.sha;
    });
  }

  /** 列出 source/_posts 下的所有 Markdown */
  function listPosts(branch) {
    return headSha(branch).then(function (sha) {
      return request('/git/trees/' + sha + '?recursive=1').then(function (tree) {
        return (tree.tree || []).filter(function (n) {
          return n.type === 'blob' && n.path.indexOf(POSTS_DIR) === 0 && /\.md$/i.test(n.path);
        }).map(function (n) {
          return {
            path: n.path,
            name: n.path.slice(POSTS_DIR.length),
            sha: n.sha,
            size: n.size,
          };
        });
      });
    });
  }

  /** 按 blob sha 读文本（列表批量取 front matter 用，比 contents 少一次重定向） */
  function readBlob(sha) {
    return request('/git/blobs/' + sha).then(function (data) {
      if (data.encoding && data.encoding !== 'base64') return String(data.content || '');
      return decodeBase64(data.content);
    });
  }

  /**
   * 并发读取多个 blob。
   * @param {Array<{sha:string}>} items
   * @param {(item:any, text:string)=>void} onEach 每成功读完一个就回调（失败不回调）
   * @param {{concurrency?:number}} [opts]
   * @returns {Promise<{done:number, failed:number}>}
   */
  function readBlobs(items, onEach, opts) {
    opts = opts || {};
    var limit = Math.max(1, opts.concurrency || 6);
    var cursor = 0;
    var done = 0;
    var failed = 0;
    function next() {
      if (cursor >= items.length) return Promise.resolve();
      var item = items[cursor];
      cursor += 1;
      return readBlob(item.sha).then(function (text) {
        done += 1;
        try { onEach(item, text); } catch (e) { /* 单个回调出错不影响其余 */ }
      }).catch(function () {
        failed += 1;
      }).then(next);
    }
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var i = 0; i < n; i += 1) workers.push(next());
    return Promise.all(workers).then(function () {
      return { done: done, failed: failed };
    });
  }

  /** 读单篇文章 */
  function readPost(path, branch) {
    return request('/contents/' + encodeURI(path) + '?ref=' + (branch || 'main')).then(function (data) {
      return {
        path: path,
        sha: data.sha,
        text: decodeBase64(data.content),
      };
    });
  }

  root.GitHubStore = {
    repo: REPO,
    postsDir: POSTS_DIR,
    login: login,
    status: status,
    headSha: headSha,
    listPosts: listPosts,
    readBlob: readBlob,
    readBlobs: readBlobs,
    readPost: readPost,
    request: request,
    decodeBase64: decodeBase64,
    encodeBase64: encodeBase64,
  };
})(window);
