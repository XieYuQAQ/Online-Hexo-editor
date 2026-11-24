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
  var IMAGES_DIR = 'source/images/';
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
  var TEXT_FILE_EXT = /\.(md|markdown|html?|ejs|styl|css|ya?ml|json|js|mjs|txt)$/i;

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
          err.request = init.method + ' ' + path;
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

  /* ---------------- 写操作（草稿分支 / 发布） ---------------- */

  /** 建 blob，返回 sha（文本按 utf-8 直接交给 GitHub，省一次 base64） */
  function createBlob(text) {
    return request('/git/blobs', {
      method: 'POST',
      body: { content: String(text == null ? '' : text), encoding: 'utf-8' },
    }).then(function (data) { return data.sha; });
  }

  /** 建二进制 blob（内容是 base64 字符串），图片上传用 */
  function createBlobBase64(base64) {
    return request('/git/blobs', {
      method: 'POST',
      body: { content: String(base64 || '').replace(/\s/g, ''), encoding: 'base64' },
    }).then(function (data) { return data.sha; });
  }

  /** 读 blob 的原始 base64（图片预览用，不再解码成 utf-8） */
  function readBlobBase64(sha) {
    return request('/git/blobs/' + sha).then(function (data) {
      return {
        base64: String(data.content || '').replace(/\s/g, ''),
        encoding: data.encoding || 'base64',
      };
    });
  }

  /** 以 baseTree 为底，覆盖/删除若干文件，返回新 tree sha */
  function createTree(baseTree, entries) {
    return request('/git/trees', {
      method: 'POST',
      body: { base_tree: baseTree, tree: entries },
    }).then(function (data) { return data.sha; });
  }

  function createCommit(message, tree, parents) {
    return request('/git/commits', {
      method: 'POST',
      body: { message: message, tree: tree, parents: parents },
    });
  }

  function createRef(branch, sha) {
    return request('/git/refs', {
      method: 'POST',
      body: { ref: 'refs/heads/' + branch, sha: sha },
    });
  }

  function updateRef(branch, sha, force) {
    return request('/git/refs/heads/' + branch, {
      method: 'PATCH',
      body: { sha: sha, force: !!force },
    });
  }

  function deleteRef(branch) {
    return request('/git/refs/heads/' + branch, { method: 'DELETE' });
  }

  function getCommit(sha) {
    return request('/git/commits/' + sha);
  }

  function getTree(sha) {
    return request('/git/trees/' + sha + '?recursive=1').then(function (tree) {
      return tree.tree || [];
    });
  }

  function compare(base, head) {
    return request('/compare/' + base + '...' + head);
  }

  /** 所有 draft/* 分支（refs/heads/draft/xxx） */
  function listDrafts() {
    return request('/git/matching-refs/heads/draft/').then(function (refs) {
      return (refs || []).filter(function (r) {
        return r && r.ref && /^refs\/heads\/draft\//.test(r.ref) && r.object && r.object.sha;
      }).map(function (r) {
        return {
          branch: r.ref.replace(/^refs\/heads\//, ''),
          sha: r.object.sha,
        };
      });
    });
  }

  /** 分支 HEAD 指向的 commit sha（不存在时抛 404） */
  function branchHead(branch) {
    return headSha(branch);
  }

  /**
   * 精确查一个分支，返回 commit sha 或 null。
   * 用 matching-refs 而不是 /git/ref/heads/...，分支不存在时返回空数组，
   * 不会在浏览器控制台留下 404。
   */
  function findRef(branch) {
    var full = 'refs/heads/' + branch;
    return request('/git/matching-refs/heads/' + branch).then(function (refs) {
      var hit = (refs || []).filter(function (r) {
        return r && r.ref === full && r.object && r.object.sha;
      })[0];
      return hit ? hit.object.sha : null;
    });
  }

  /** 分支是否存在 */
  function branchExists(branch) {
    return headSha(branch).then(function () { return true; }).catch(function (e) {
      if (e.status === 404) return false;
      throw e;
    });
  }

  /** 分支上 source/_posts 里的 Markdown */
  function listPostsOn(branch, head) {
    var headPromise = head ? Promise.resolve(head) : headSha(branch);
    return headPromise.then(function (sha) {
      return getTree(sha).then(function (tree) {
        return tree.filter(function (n) {
          return n.type === 'blob' && n.path.indexOf(POSTS_DIR) === 0 && /\.md$/i.test(n.path);
        }).map(function (n) {
          return { path: n.path, name: n.path.slice(POSTS_DIR.length), sha: n.sha, size: n.size };
        });
      });
    });
  }

  /** 某个分支上的图片（source/images/**） */
  function listImages(branch, head) {
    var headPromise = head ? Promise.resolve(head) : headSha(branch || 'main');
    return headPromise.then(function (sha) {
      return getTree(sha).then(function (tree) {
        return tree.filter(function (n) {
          return n.type === 'blob' && n.path.indexOf(IMAGES_DIR) === 0 && IMAGE_EXT.test(n.path);
        }).map(function (n) {
          return { path: n.path, sha: n.sha, size: n.size };
        });
      });
    });
  }

  /** 分支上所有文本文件（引用扫描用） */
  function listTextFiles(branch, head) {
    var headPromise = head ? Promise.resolve(head) : headSha(branch || 'main');
    return headPromise.then(function (sha) {
      return getTree(sha).then(function (tree) {
        return tree.filter(function (n) {
          if (n.type !== 'blob') return false;
          var p = n.path;
          if (!TEXT_FILE_EXT.test(p)) return false;
          if (/package-lock\.json$/i.test(p)) return false;
          if (/^(node_modules|public|tools|\.deploy_git|\.git)\//.test(p)) return false;
          return true;
        }).map(function (n) {
          return { path: n.path, sha: n.sha, size: n.size };
        });
      });
    });
  }

  root.GitHubStore = {
    repo: REPO,
    postsDir: POSTS_DIR,
    imagesDir: IMAGES_DIR,
    login: login,
    status: status,
    headSha: headSha,
    listPosts: listPosts,
    readBlob: readBlob,
    readBlobs: readBlobs,
    readPost: readPost,
    createBlob: createBlob,
    createBlobBase64: createBlobBase64,
    readBlobBase64: readBlobBase64,
    createTree: createTree,
    createCommit: createCommit,
    createRef: createRef,
    updateRef: updateRef,
    deleteRef: deleteRef,
    getCommit: getCommit,
    getTree: getTree,
    compare: compare,
    listDrafts: listDrafts,
    branchHead: branchHead,
    findRef: findRef,
    branchExists: branchExists,
    listPostsOn: listPostsOn,
    listImages: listImages,
    listTextFiles: listTextFiles,
    request: request,
    decodeBase64: decodeBase64,
    encodeBase64: encodeBase64,
  };
})(window);
