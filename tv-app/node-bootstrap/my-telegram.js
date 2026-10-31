// Gets the user's own Telegram API ID/hash from my.telegram.org, the same way
// the website does: phone number → login code (sent by Telegram to the user's
// Telegram app) → session cookie → read the app on /apps, creating it first if
// the account has none.

'use strict';

const BASE = 'https://my.telegram.org';

// Cookies (stel_token, stel_ssid) from a response's Set-Cookie header(s).
function cookiesFrom(res, jar) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie().join('\n')
    : res.headers.get('set-cookie') || '';
  for (const m of raw.matchAll(/(stel_[a-z_]+)=([^;,\s]*)/gi)) jar[m[1]] = m[2];
}

async function request(path, { jar, form } = {}) {
  // The site's own scripts send POSTs as XHR; pages are plain GETs.
  const headers = form ? { 'X-Requested-With': 'XMLHttpRequest' } : {};
  const cookie = Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.Cookie = cookie;
  const init = { headers, redirect: 'manual' };
  if (form) {
    init.method = 'POST';
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(BASE + path, init);
  if (jar) cookiesFrom(res, jar);
  return { status: res.status, text: (await res.text()).trim() };
}

// "+972 50-123 4567" → "+972501234567". Telegram needs the country code.
function normalizePhone(input) {
  const phone = String(input || '').replace(/[\s\-().]/g, '');
  if (/^00\d{8,15}$/.test(phone)) return '+' + phone.slice(2);
  if (/^\+\d{8,15}$/.test(phone)) return phone;
  return null;
}

// Step 1: Telegram sends a login code to the user's Telegram app.
async function sendCode(phone) {
  const jar = {};
  const res = await request('/auth/send_password', { jar, form: { phone } });
  let body;
  try { body = JSON.parse(res.text); } catch { body = null; }
  if (!body || !body.random_hash) {
    const text = (body && body.text) || res.text || `my.telegram.org answered HTTP ${res.status}`;
    throw new Error(/too many tries/i.test(text)
      ? 'Telegram says: too many tries. Wait a few hours (sometimes up to a day) and try again.'
      : text);
  }
  return { phone, randomHash: body.random_hash, jar };
}

// Values shown on /apps once the account has an app: the first value after
// the "api_id" / "api_hash" labels.
// The markup changes now and then (the hash is sometimes masked on screen and
// only present in an attribute), so take the first matching value after the
// "api_id" / "api_hash" label, anywhere in the markup.
function valueAfter(html, label, pattern) {
  const at = html.search(label);
  if (at < 0) return undefined;
  return (html.slice(at, at + 2000).match(pattern) || [])[1];
}

function parseKeys(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const apiId = valueAfter(body, /api[_ ]id/i, /(?<![\d.:])(\d{5,12})(?![\d.:])/);
  const apiHash = valueAfter(body, /api[_ ]hash/i, /(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i);
  return apiId && apiHash ? { apiId, apiHash: apiHash.toLowerCase() } : null;
}

// Page markup for the log with every value-like string masked.
function redactedPage(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '<script/>')
    .replace(/[0-9a-f]{16,}/gi, '<HEX>')
    .replace(/\+?\d{4,}/g, '<NUM>')
    .replace(/\s+/g, ' ');
}

// An account has at most one app; its page is titled "App configuration".
function hasApp(html) {
  return /<title>\s*App configuration/i.test(html);
}

// What the page looks like, for the log — never the values themselves.
function describePage(html) {
  const title = ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const inputs = [...html.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const labels = [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  return `title="${title}" length=${html.length} inputs=[${inputs}] labels=[${labels.slice(0, 12).join(' | ')}]`;
}

// The create-app form's anti-CSRF token.
function parseFormHash(html) {
  const tag = (html.match(/<input[^>]*name="hash"[^>]*>/) || [])[0] || '';
  return (tag.match(/value="([^"]+)"/) || [])[1] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Step 2: log in with the code, then read (or create) the app's keys.
// `pending` remembers the login, so a retry after a later failure needs no new code.
async function fetchKeys(pending, code, onProgress = () => {}) {
  const { phone, randomHash, jar } = pending;
  if (!pending.loggedIn) {
    const login = await request('/auth/login', {
      jar,
      form: { phone, random_hash: randomHash, password: String(code).trim() },
    });
    if (login.text !== 'true') throw new Error(login.text || 'Login failed');
    pending.loggedIn = true;
  }

  onProgress('reading');
  let page = await request('/apps', { jar });
  console.log(`[setup] /apps HTTP ${page.status} ${describePage(page.text)}`);
  let keys = parseKeys(page.text);
  if (keys) return { ...keys, created: false };
  if (hasApp(page.text)) {
    const masked = redactedPage(page.text);
    for (let i = 0; i < masked.length; i += 900) console.log('[setup] page ' + masked.slice(i, i + 900));
    throw new Error('Could not read the keys from your app on my.telegram.org. ' +
      'Open "I already have an api_id and api_hash" below and paste them from my.telegram.org.');
  }

  // No app yet. Telegram sometimes answers "ERROR" at first; retry a little.
  onProgress('creating');
  let answer = '';
  for (let attempt = 0; attempt < 4 && !keys; attempt++) {
    const hash = parseFormHash(page.text);
    if (!hash) throw new Error('Unexpected page from my.telegram.org (no app form)');
    if (attempt) await sleep(3000);
    const created = await request('/apps/create', {
      jar,
      form: {
        hash,
        app_title: 'Telemedia TV',
        app_shortname: 'telemedia' + Math.floor(100000 + Math.random() * 900000),
        app_url: '',
        app_platform: 'android',
        app_desc: '',
      },
    });
    answer = /</.test(created.text) ? '' : created.text.slice(0, 200); // not a whole page
    console.log(`[setup] /apps/create HTTP ${created.status} answer="${answer}"`);
    page = await request('/apps', { jar });
    keys = parseKeys(page.text);
  }
  if (!keys) {
    console.log(`[setup] /apps after create: ${describePage(page.text)}`);
    throw new Error(`Telegram did not create the app${answer ? ` ("${answer}")` : ''}. ` +
      'Try again in a few minutes, or create it on my.telegram.org yourself.');
  }
  return { ...keys, created: true };
}

module.exports = { normalizePhone, sendCode, fetchKeys, parseKeys, parseFormHash, describePage };
