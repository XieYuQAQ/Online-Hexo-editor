// GitHub App 授权回调：用 code 换 user token，加密后写入 httpOnly cookie
// 必须在 GitHub App 的 Redirect URI 中登记本函数地址
const crypto = require('crypto');
const { callback, editorReturn } = require('./lib/config');

const CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET;
const TOKEN_SECRET = process.env.GITHUB_TOKEN_SECRET;

// 与 github-api.js 保持一致：gh_token 只在 /api/github 下发送
const COOKIE_PATH = '/api/github';

function key() {
  return crypto.createHash('sha256').update(String(TOKEN_SECRET || '')).digest();
}

/** 常量时间比较：先 sha256 归一化，长度不等也不会抛错 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** AES-256-GCM 封装：iv(12) + tag(16) + ciphertext，base64url */
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function getCookie(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(header || '');
  return m ? m[1] : '';
}

function back(reason) {
  return {
    statusCode: 302,
    headers: {
      location: editorReturn('error', reason),
      'set-cookie': 'gh_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'cache-control': 'no-store',
    },
    body: '',
  };
}

exports.handler = async (event) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !callback) return back('app_not_configured');
  if (!TOKEN_SECRET) return back('token_secret_missing');

  const q = event.queryStringParameters || {};
  if (!q.code) return back('no_code');

  const expected = getCookie(event.headers?.cookie, 'gh_oauth_state');
  if (!q.state || !expected || !safeEqual(q.state, expected)) return back('state_mismatch');

  let data;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: q.code,
        redirect_uri: callback,
      }),
    });
    data = await res.json();
  } catch (e) {
    return back('exchange_failed');
  }

  if (!data || !data.access_token) return back(data && data.error ? data.error : 'no_token');

  const payload = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || '',
    expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 3600 * 1000),
  };

  const maxAge = Math.max(600, Math.floor((payload.expires_at - Date.now()) / 1000));

  return {
    statusCode: 302,
    headers: {
      location: editorReturn('ok'),
      'cache-control': 'no-store',
    },
    // Netlify 的 headers 只接受字符串，多个 Set-Cookie 必须走 multiValueHeaders
    multiValueHeaders: {
      'set-cookie': [
        `gh_token=${seal(payload)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        // 清掉旧版 Path=/ 的残留，否则浏览器里会同时存在两条同名 Cookie
        'gh_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        'gh_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      ],
    },
    body: '',
  };
};
