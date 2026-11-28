'use strict';

const { EDITOR_PATH, httpsUrl } = require('./lib/config');

const UPSTREAM = httpsUrl(process.env.ONLINE_HEXO_EDITOR_UPSTREAM);
const ASSETS = new Map([
  ['/', ['/', 'text/html; charset=utf-8']],
  ['/index.html', ['/index.html', 'text/html; charset=utf-8']],
  ['/assets/editor.css', ['/assets/editor.css', 'text/css; charset=utf-8']],
  ['/assets/core.js', ['/assets/core.js', 'text/javascript; charset=utf-8']],
  ['/assets/github.js', ['/assets/github.js', 'text/javascript; charset=utf-8']],
  ['/assets/app.js', ['/assets/app.js', 'text/javascript; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

function error(statusCode, body) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'HEAD') return error(405, 'Method not allowed');

  const path = new URL(event.rawUrl).pathname;
  if (path !== EDITOR_PATH && !path.startsWith(EDITOR_PATH + '/')) return error(404, 'Not found');

  const relative = path.slice(EDITOR_PATH.length) || '/';
  const asset = ASSETS.get(relative);
  if (!asset) return error(404, 'Not found');
  if (!UPSTREAM || UPSTREAM.search) return error(500, 'ONLINE_HEXO_EDITOR_UPSTREAM 必须配置为 HTTPS 地址');

  const [filename, contentType] = asset;
  const target = UPSTREAM.href.replace(/\/+$/, '') + filename;
  try {
    const res = await fetch(target, { method, redirect: 'error' });
    if (!res.ok) return error(res.status, '编辑器静态资源不可用');
    let body = method === 'HEAD' ? '' : await res.text();
    if (contentType.startsWith('text/html')) {
      body = body.replace(/<head([^>]*)>/i, (tag) => tag + '\n<base href="' + EDITOR_PATH + '/">');
    }
    return {
      statusCode: res.status,
      headers: { ...SECURITY_HEADERS, 'content-type': contentType, 'cache-control': 'no-cache, must-revalidate' },
      body,
    };
  } catch {
    return error(502, '编辑器静态资源代理暂不可用');
  }
};
