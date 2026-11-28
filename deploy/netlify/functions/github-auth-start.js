// GitHub App 授权入口：跳转到 GitHub 授权页，并带一个 state 防 CSRF
// 前端入口：/api/github/auth/start（netlify.toml 里重写到本函数）
const crypto = require('crypto');
const { callback, editorReturn } = require('./lib/config');

const CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID;

function randomState() {
  return crypto.randomBytes(16).toString('base64url');
}

exports.handler = async () => {
  if (!CLIENT_ID || !callback) {
    return {
      statusCode: 302,
      headers: { location: editorReturn('error', 'app_not_configured'), 'cache-control': 'no-store' },
      body: '',
    };
  }

  const state = randomState();
  const authorize =
    'https://github.com/login/oauth/authorize?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: callback,
      state,
    }).toString();

  return {
    statusCode: 302,
    headers: {
      location: authorize,
      // 短有效期，只用于这一次回调校验
      'set-cookie': `gh_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      'cache-control': 'no-store',
    },
    body: '',
  };
};
