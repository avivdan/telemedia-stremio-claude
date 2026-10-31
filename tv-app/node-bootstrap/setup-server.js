// First-run setup from the phone. The TV shows a QR code with
// http://<tv-ip>:7002/; the page asks for the phone number and the login code
// Telegram sends, and the TV gets the user's own API ID/hash from
// my.telegram.org (my-telegram.js). Listens on the LAN only while setup runs.

'use strict';

const http = require('http');
const myTelegram = require('./my-telegram');

const SETUP_PORT = 7002;
const MAX_BODY = 4096;

// run({ onStep }) → Promise<{ apiId, apiHash }>. onStep(step, detail) reports
// progress for the TV screen: 'code_sent' | 'reading' | 'creating' | 'error'.
function run({ onStep = () => {} } = {}) {
  return new Promise((resolve) => {
    let pending = null; // { phone, randomHash, jar } between the two steps
    let busy = false;

    const server = http.createServer((req, res) => {
      const send = (code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
      };

      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        return send(200, PAGE, 'text/html; charset=utf-8');
      }
      if (req.method !== 'POST' || !req.url.startsWith('/api/')) return send(404, { error: 'not found' });

      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', async () => {
        let input;
        try { input = JSON.parse(body || '{}'); } catch { return send(400, { error: 'Bad request' }); }
        if (busy) return send(409, { error: 'Still working on the previous step, wait a moment.' });
        busy = true;
        try {
          if (req.url === '/api/phone') {
            const phone = myTelegram.normalizePhone(input.phone);
            if (!phone) return send(400, { error: 'Enter the full number with the country code, e.g. +972 50 123 4567.' });
            pending = await myTelegram.sendCode(phone);
            onStep('code_sent');
            return send(200, { ok: true });
          }
          if (req.url === '/api/code') {
            if (!pending) return send(400, { error: 'Send the phone number first.' });
            const keys = await myTelegram.fetchKeys(pending, input.code, (step) => onStep(step));
            finish(keys);
            return send(200, { ok: true, created: keys.created });
          }
          if (req.url === '/api/keys') {
            const apiId = String(input.apiId || '').trim();
            const apiHash = String(input.apiHash || '').trim().toLowerCase();
            if (!/^\d{3,12}$/.test(apiId)) return send(400, { error: 'api_id is a number.' });
            if (!/^[0-9a-f]{32}$/.test(apiHash)) return send(400, { error: 'api_hash is 32 letters and digits.' });
            finish({ apiId, apiHash });
            return send(200, { ok: true });
          }
          return send(404, { error: 'not found' });
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          onStep('error', message);
          return send(502, { error: message });
        } finally {
          busy = false;
        }
      });
    });

    function finish(keys) {
      pending = null;
      // Let the response reach the phone, then stop listening on the LAN.
      setTimeout(() => server.close(), 1000);
      resolve({ apiId: keys.apiId, apiHash: keys.apiHash });
    }

    server.on('error', (err) => console.error('[setup] server error', err.message));
    server.listen(SETUP_PORT, '0.0.0.0', () => console.log('[setup] phone setup page on port ' + SETUP_PORT));
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telemedia setup</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1d2329; --muted: #5d6874; --accent: #2a8bd8; --err: #c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg: #101418; --card: #1a2027; --fg: #e6edf3; --muted: #9aa6b2; --err: #ff6b6b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 17px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 440px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .card { background: var(--card); border-radius: 14px; padding: 18px; margin-top: 18px; }
  p { margin: 0 0 12px; color: var(--muted); }
  input { width: 100%; font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #8884; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 12px; font: inherit; font-weight: 600; padding: 12px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; }
  button:disabled { opacity: .6; }
  .err { color: var(--err); margin-top: 10px; min-height: 1em; }
  details { margin-top: 18px; color: var(--muted); }
  details input { margin-top: 8px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Telemedia setup</h1>
  <p>Connects the TV to your Telegram account. Your number is only sent to Telegram (my.telegram.org).</p>

  <section class="card" id="step-phone">
    <p><b>1.</b> Your Telegram phone number, with the country code:</p>
    <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+972 50 123 4567">
    <button id="send-phone">Send code</button>
    <div class="err" id="err-phone"></div>
  </section>

  <section class="card" id="step-code" hidden>
    <p><b>2.</b> Telegram sent you a login code: open the Telegram app, chat <b>Telegram</b> (blue tick). Enter the code here:</p>
    <input id="code" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Login code">
    <button id="send-code">Continue</button>
    <div class="err" id="err-code"></div>
  </section>

  <section class="card" id="step-done" hidden>
    <p style="color:inherit"><b>Done!</b> Now look at the TV and scan the Telegram code there
    (Telegram → Settings → Devices → Link Desktop Device).</p>
  </section>

  <details id="manual">
    <summary>I already have an api_id and api_hash</summary>
    <input id="api-id" inputmode="numeric" placeholder="api_id">
    <input id="api-hash" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="api_hash">
    <button id="send-keys">Save</button>
    <div class="err" id="err-keys"></div>
  </details>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  async function post(path, body, button, errBox) {
    errBox.textContent = '';
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Please wait…';
    try {
      const res = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ')');
      return data;
    } catch (e) {
      errBox.textContent = e.message;
      return null;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }
  function done() {
    for (const id of ['step-phone', 'step-code', 'manual']) $(id).hidden = true;
    $('step-done').hidden = false;
  }
  $('send-phone').onclick = async () => {
    if (await post('/api/phone', { phone: $('phone').value }, $('send-phone'), $('err-phone'))) {
      $('step-code').hidden = false;
      $('send-phone').textContent = 'Send a new code';
      $('code').focus();
    }
  };
  $('send-code').onclick = async () => {
    if (await post('/api/code', { code: $('code').value }, $('send-code'), $('err-code'))) done();
  };
  $('send-keys').onclick = async () => {
    const body = { apiId: $('api-id').value, apiHash: $('api-hash').value };
    if (await post('/api/keys', body, $('send-keys'), $('err-keys'))) done();
  };
</script>
</body>
</html>
`;

module.exports = { run, SETUP_PORT };
