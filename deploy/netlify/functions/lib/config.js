'use strict';

const EDITOR_PATH = '/tools/online-hexo-editor';
const RETURN_BASE = 'https://editor.invalid';

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function editorReturn(status, reason) {
  const configured = (process.env.GITHUB_AUTH_RETURN || '').trim();
  const path = /^\/(?!\/)[^\\\x00-\x20\x7f]*$/.test(configured) ? configured : EDITOR_PATH + '/';
  let url = new URL(path, RETURN_BASE);
  if (url.origin !== RETURN_BASE || url.pathname.startsWith('//')) {
    url = new URL(EDITOR_PATH + '/', RETURN_BASE);
  }
  url.searchParams.set('auth', status);
  if (reason) url.searchParams.set('reason', reason);
  else url.searchParams.delete('reason');
  return url.pathname + url.search + url.hash;
}

const callbackAddress = (process.env.GITHUB_AUTH_CALLBACK || '').trim();
const callback = httpsUrl(callbackAddress) ? callbackAddress : '';

module.exports = { EDITOR_PATH, callback, editorReturn, httpsUrl };
