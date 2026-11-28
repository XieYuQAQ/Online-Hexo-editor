// GitHub API 代理：校验登录态、注入 token、限制仓库 / 端点 / 方法，并处理 token 续期
// 前端调用 /api/github/repo/...，服务端从 GITHUB_REPO 选择目标仓库
const crypto = require('crypto');
const { WriteError, writePolicy } = require('./lib/github-writes');

const REPO = (process.env.GITHUB_REPO || '').trim();
const ROUTE = '/api/github/repo';
const LEGACY_ROUTE = '/api/github/repos/' + REPO.toLowerCase();
const UPSTREAM = 'https://api.github.com/repos/' + REPO;
const TOKEN_SECRET = process.env.GITHUB_TOKEN_SECRET;
const CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;

// PUT 前端从未使用，直接不接受
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const TEXT_TYPES = /^(text\/|application\/(json|xml)|image\/svg\+xml)/i;

// gh_token 只在 /api/github 下发送。
// 注意：授权回调挂在 /.netlify/functions/github-auth-callback，读不到这个 Cookie，
// 所以 gh_oauth_state 必须保持 Path=/（否则 state 校验必然失败）。
const COOKIE_PATH = '/api/github';

// 合法路径里不会出现转义的点 / 斜杠 / 反斜杠（中文文件名是 %E4 这类，不受影响）
const BAD_ESCAPE = /%(?:2e|2f|5c)/i;

const SHA = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const REF = '[A-Za-z0-9._/-]+';

// 端点白名单：仓库路由之后允许的相对路径
const ALLOWED = {
  GET: [
    /^$/,                                                             // 仓库信息
    new RegExp('^/git/ref/heads/' + REF + '$'),                       // 分支 HEAD（单数 ref）
    new RegExp('^/git/matching-refs/heads/draft/[A-Za-z0-9._/-]*$'),  // 列 / 精确查草稿分支
    new RegExp('^/git/trees/' + SHA + '$'),
    new RegExp('^/git/blobs/' + SHA + '$'),
    new RegExp('^/git/commits/' + SHA + '$'),
    /^\/contents\/source\/(?:_posts|images)\//,                        // 只读文章与图片目录
    new RegExp('^/compare/' + REF + '\\.\\.\\.' + REF + '$')
  ],
  POST: [
    /^\/git\/blobs$/,
    /^\/git\/trees$/,
    /^\/git\/commits$/,
    /^\/git\/refs$/                                                   // body.ref 另外校验，只能是 draft/*
  ],
  PATCH: [
    /^\/git\/refs\/heads\/main$/,                                     // 发布：main 前移
    new RegExp('^/git/refs/heads/draft/' + REF + '$')                  // 草稿分支更新
  ],
  DELETE: [
    new RegExp('^/git/refs/heads/draft/' + REF + '$')                  // 只删草稿，main 一律拒绝
  ]
};

function key() {
  return crypto.createHash('sha256').update(String(TOKEN_SECRET || '')).digest();
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function open(value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
  } catch (e) {
    return null;
  }
}

function getCookie(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(header || '');
  return m ? m[1] : '';
}

function cookieFor(payload, maxAge) {
  return `gh_token=${seal(payload)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 统一响应：API 一律 JSON + nosniff，避免被当成可执行文档打开 */
function json(statusCode, body, extra) {
  return {
    statusCode,
    headers: Object.assign({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }, extra || {}),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

async function refresh(payload) {
  if (!payload.refresh_token) return null;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: payload.refresh_token,
      }),
    });
    const data = await res.json();
    if (!data || !data.access_token) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || payload.refresh_token,
      expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 3600 * 1000),
    };
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(REPO) || /\/(?:\.|\.\.)$/.test(REPO)) {
    return json(500, { error: 'GITHUB_REPO 必须配置为 owner/repo' });
  }
  if (!TOKEN_SECRET) return json(500, { error: 'TOKEN_SECRET 未配置' });

  const reqHeaders = event.headers || {};
  const url = new URL(event.rawUrl);
  const path = url.pathname;
  const lower = path.toLowerCase();

  // 旧前端仍可请求已配置的仓库，便于先升级代理再升级页面。
  const prefix = [ROUTE, LEGACY_ROUTE].find(route => lower === route || lower.startsWith(route + '/'));
  if (!prefix) {
    return json(403, { error: 'repo not allowed' });
  }

  // 2) 拒绝编码过的点 / 斜杠 / 反斜杠，堵住 ..%2f、%2e%2e 之类变形
  if (BAD_ESCAPE.test(path)) {
    return json(403, { error: 'path not allowed' });
  }

  const rest = path.slice(prefix.length);

  // 3) 方法 + 端点白名单
  const method = event.httpMethod;
  if (!METHODS.has(method)) return json(405, { error: 'method not allowed' });
  const rules = ALLOWED[method];
  if (!rules || !rules.some((re) => re.test(rest))) {
    return json(403, { error: 'endpoint not allowed' });
  }

  if (method !== 'GET' && url.search) return json(400, { error: '写操作不接受查询参数' });

  let payload = open(getCookie(reqHeaders.cookie, 'gh_token'));
  if (!payload || !payload.access_token) {
    return json(401, { error: 'not signed in' });
  }

  let setCookie = '';
  if (payload.expires_at && payload.expires_at < Date.now() + 60000) {
    const next = await refresh(payload);
    if (next) {
      payload = next;
      const maxAge = Math.max(600, Math.floor((next.expires_at - Date.now()) / 1000));
      setCookie = cookieFor(next, maxAge);
    }
  }

  const headers = {
    authorization: 'Bearer ' + payload.access_token,
    // 固定 JSON：不透传浏览器的 Accept（否则可用 application/vnd.github.raw 取到原始 svg/html）
    accept: 'application/vnd.github+json',
    'user-agent': 'online-hexo-editor',
    'x-github-api-version': '2022-11-28',
  };
  let upstream;
  try {
    let body;
    if (method === 'POST' || method === 'PATCH') {
      let data;
      try {
        data = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        throw new WriteError(400, '需要 JSON 请求体');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WriteError(400, '需要 JSON 对象');
      const policy = writePolicy(async (endpoint) => {
        const response = await fetch(UPSTREAM + endpoint, { headers, redirect: 'error' });
        if (!response.ok) throw new WriteError(response.status, 'GitHub 无法读取校验所需的对象');
        return response.json();
      });
      if (rest === '/git/trees') {
        data = await policy.checkEntries(data);
      } else if (rest === '/git/refs') {
        if (typeof data.ref !== 'string' || !new RegExp('^refs/heads/draft/' + REF + '$').test(data.ref)) {
          throw new WriteError(403, 'ref not allowed');
        }
        await policy.checkRef('main', data.sha);
        data = { ref: data.ref, sha: data.sha };
      } else if (method === 'PATCH') {
        if (Object.hasOwn(data, 'force') && data.force !== false) throw new WriteError(403, '不允许强制更新分支');
        await policy.checkRef(rest.slice('/git/refs/heads/'.length), data.sha);
        data = { sha: data.sha, force: false };
      }
      headers['content-type'] = 'application/json';
      body = JSON.stringify(data);
    }
    upstream = await fetch(UPSTREAM + rest + url.search, {
      method,
      headers,
      body,
      redirect: 'error',
    });
  } catch (e) {
    const status = e instanceof WriteError ? e.status : 502;
    return json(status, { error: e instanceof WriteError ? e.message : 'upstream failed' },
      setCookie ? { 'set-cookie': setCookie } : {});
  }

  // 401 时绝不下发「清 Cookie」：
  // 并发刷新时只有第一个请求能换到新 token，其余请求拿着已失效的旧 token 打 GitHub 必然 401，
  // 清掉会把刚写回的新 Cookie 覆盖，用户会莫名掉线。
  // 真需要重登时由前端跳授权，回调页会直接写入新 gh_token。
  if (upstream.status === 401) {
    const extra = {};
    if (setCookie) extra['set-cookie'] = setCookie;   // 本次刷新成功就保留新 token
    return json(401, { error: 'token expired' }, extra);
  }

  const contentType = (upstream.headers.get('content-type') || 'application/json').toLowerCase();
  const outHeaders = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (setCookie) outHeaders['set-cookie'] = setCookie;

  if (TEXT_TYPES.test(contentType)) {
    return { statusCode: upstream.status, headers: outHeaders, body: await upstream.text() };
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  outHeaders['content-type'] = contentType || 'application/octet-stream';
  return {
    statusCode: upstream.status,
    headers: outHeaders,
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
