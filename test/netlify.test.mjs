import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const functions = '../deploy/netlify/functions/';
const editor = '/tools/online-hexo-editor';
const callbackUrl = 'https://blog.example.com/.netlify/functions/github-auth-callback';
const upstream = 'https://deploy-id--editor.example.com';
const repo = 'example-owner/example-blog';
const event = (path, options = {}) => ({ rawUrl: 'https://blog.example.com' + path, httpMethod: 'GET', headers: {}, ...options });

await test('repo route requires an explicit repository', async () => {
  delete process.env.GITHUB_REPO;
  const modulePath = require.resolve(functions + 'github-api.js');
  const api = require(modulePath).handler;
  const response = await api(event('/api/github/repo'));
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /GITHUB_REPO/);
  delete require.cache[modulePath];
});

await test('OAuth, repo route and legacy route use server configuration', async () => {
  Object.assign(process.env, {
    GITHUB_REPO: repo,
    GITHUB_APP_CLIENT_ID: 'test-app',
    GITHUB_APP_CLIENT_SECRET: 'test-secret',
    GITHUB_TOKEN_SECRET: 'test-session-key',
    GITHUB_AUTH_CALLBACK: callbackUrl,
    GITHUB_AUTH_RETURN: editor + '/?tab=posts#top',
  });
  const start = require(functions + 'github-auth-start.js').handler;
  const callback = require(functions + 'github-auth-callback.js').handler;
  const api = require(functions + 'github-api.js').handler;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const data = url === 'https://github.com/login/oauth/access_token'
      ? { access_token: 'test-user-token' }
      : { full_name: repo, default_branch: 'main', private: true };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const anonymous = await api(event('/api/github/repo'));
    assert.equal(anonymous.statusCode, 401);
    assert.equal(calls.length, 0);
    assert.equal((await api(event('/api/github/repos/example-owner/other-blog'))).statusCode, 403);

    const authorization = await start();
    const params = new URL(authorization.headers.location).searchParams;
    assert.equal(params.get('redirect_uri'), callbackUrl);
    const stateCookie = authorization.headers['set-cookie'].split(';')[0];
    const signedIn = await callback({
      queryStringParameters: { code: 'test-code', state: params.get('state') },
      headers: { cookie: stateCookie },
    });
    assert.equal(signedIn.headers.location, editor + '/?tab=posts&auth=ok#top');
    assert.equal(JSON.parse(calls[0].init.body).redirect_uri, callbackUrl);
    const sessionCookie = signedIn.multiValueHeaders['set-cookie'][0];
    assert.match(sessionCookie, /Path=\/api\/github; HttpOnly; Secure; SameSite=Lax/);
    assert.ok(!sessionCookie.includes('test-user-token'));
    const headers = { cookie: sessionCookie.split(';')[0] };

    const metadata = await api(event('/api/github/repo', { headers }));
    assert.equal(JSON.parse(metadata.body).full_name, repo);
    assert.equal(metadata.headers['cache-control'], 'no-store');
    await api(event('/api/github/repo/git/trees/' + 'a'.repeat(40) + '?recursive=1', { headers }));
    const legacy = await api(event('/api/github/repos/' + repo, { headers }));
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(calls.slice(1).map(({ url }) => url), [
      'https://api.github.com/repos/' + repo,
      'https://api.github.com/repos/' + repo + '/git/trees/' + 'a'.repeat(40) + '?recursive=1',
      'https://api.github.com/repos/' + repo,
    ]);

    const noCode = await callback({ queryStringParameters: {} });
    assert.equal(noCode.headers.location, editor + '/?tab=posts&auth=error&reason=no_code#top');
    process.env.GITHUB_AUTH_RETURN = 'https://other.example.com/';
    const invalidReturn = await callback({ queryStringParameters: {} });
    assert.equal(invalidReturn.headers.location, editor + '/?auth=error&reason=no_code');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('editor proxy uses the selected static deployment and serves editor files', async () => {
  process.env.ONLINE_HEXO_EDITOR_UPSTREAM = upstream + '/frontend/';
  const proxy = require(functions + 'online-hexo-editor-proxy.js').handler;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response('<html><head></head><body></body></html>');
  };
  try {
    const page = await proxy(event(editor + '/?auth=ok'));
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('<base href="' + editor + '/">'));
    const script = await proxy(event(editor + '/assets/github.js'));
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await proxy(event(editor + '/package.json'))).statusCode, 404);
    assert.deepEqual(calls, [upstream + '/frontend/', upstream + '/frontend/assets/github.js']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
