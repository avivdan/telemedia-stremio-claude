// Renders Telemedia's status into the page. The page is static: render() only
// shows/hides panes and sets texts, so a half-typed password survives every
// update. It talks to Telemedia.exe (shell/Program.cs) through WebView2
// messages: status comes in, actions go out. Bundled by scripts/build.mjs.
import QRCode from 'qrcode';

const $ = (id) => document.getElementById(id);
const bridge = window.chrome && window.chrome.webview;
const send = (action, extra = {}) => bridge && bridge.postMessage({ action, ...extra });

const qrCache = new Map();
function qrImage(text) {
  if (!text) return null;
  if (!qrCache.has(text)) {
    if (qrCache.size > 20) qrCache.clear();
    qrCache.set(text, QRCode.toDataURL(text, {
      margin: 1, width: 440, errorCorrectionLevel: 'M', color: { dark: '#0E1621', light: '#FFFFFF' },
    }));
  }
  return qrCache.get(text);
}

let latest = {};
let updates = 0;
let logWaiter = null;
const api = {
  onStatus(callback) {
    if (!bridge) return;
    bridge.addEventListener('message', async (e) => {
      const m = e.data || {};
      if (m.type === 'log') {
        if (logWaiter) logWaiter(m.text);
        logWaiter = null;
        return;
      }
      if (m.type !== 'status') return;
      const seq = ++updates;
      const s = m.status || { state: 'offline' };
      const stremio = s.stremio || { state: 'idle' };
      const view = {
        ...s,
        ...m.app,
        stremio,
        // The page gets a picture of the login code, not the token as text.
        telegramQr: s.state === 'qr' ? await qrImage(s.qrUrl) : null,
        stremioQr: stremio.state === 'waiting' ? await qrImage(stremio.link) : null,
      };
      delete view.qrUrl;
      if (seq !== updates) return; // a newer status arrived meanwhile
      latest = view;
      callback(view);
    });
    send('ready');
  },
  sendPassword: (value) => send('password', { value }),
  restart: () => send('restart'),
  logout: () => send('logout'),
  connectStremio: () => send('connect-stremio', { link: latest.stremio && latest.stremio.link }),
  openStremio: () => send('open-stremio'),
  copyAddress: () => {
    if (!latest.manifestUrl) return false;
    send('copy-address', { url: latest.manifestUrl });
    return true;
  },
  openSetupPage: () => send('open-setup'),
  setAutostart: (value) => send('set-autostart', { value }),
  openLogs: () => send('open-log'),
  copyLog: () => send('copy-log'),
  getLog: () => new Promise((resolve) => {
    logWaiter = resolve;
    send('get-log');
    setTimeout(() => { if (logWaiter === resolve) { logWaiter = null; resolve(''); } }, 3000);
  }),
};

const TELEGRAM_DONE = new Set(['starting_addon', 'running']);

function headline(v) {
  const stremioDone = isStremioDone(v);
  switch (v.state) {
    case 'qr':
      return ['Link your Telegram', 'Scan the Telegram code with your phone. You can scan the Stremio code at the same time.'];
    case 'need_password':
      return ['Enter your Telegram password', 'This account has two-step verification turned on.'];
    case 'auto_setup':
      return ['Getting your own Telegram key', 'About a minute. Nothing to do.'];
    case 'need_config':
      return ['Finish setup in your browser', 'Automatic setup didn’t work this time. The setup page gets your key another way.'];
    case 'logging_in':
      return ['Connecting to Telegram', 'One moment.'];
    case 'starting_addon':
      return ['Starting Telemedia', 'Almost there.'];
    case 'running':
      return stremioDone
        ? ['Telemedia is running', 'Open any movie or episode in Stremio and pick a Telemedia stream. You can close this window; Telemedia stays in the tray.']
        : ['One more step: connect Stremio', 'This adds Telemedia to your Stremio account, once.'];
    case 'error':
      return ['Telemedia stopped', 'See the message below, then restart.'];
    default:
      return ['Starting Telemedia', 'One moment.'];
  }
}

function isStremioDone(v) {
  return !!v.stremioConnected || (v.stremio && v.stremio.state === 'done');
}

function telegramPane(v) {
  switch (v.state) {
    case 'qr': return 'tg-qr';
    case 'need_password': return 'tg-password';
    case 'auto_setup': return 'tg-steps';
    case 'need_config': return 'tg-setup';
    case 'error': return 'tg-error';
    case 'starting_addon':
    case 'running': return 'tg-done';
    default: return 'tg-wait';
  }
}

function stremioPane(v) {
  if (isStremioDone(v)) return 'st-done';
  if (v.state === 'error') return 'none';
  if (v.state === 'need_config') return 'st-later';
  switch (v.stremio && v.stremio.state) {
    case 'waiting': return v.stremioQr ? 'st-qr' : 'st-later';
    case 'installing': return 'st-installing';
    case 'error': return 'st-error';
    default: return 'st-later';
  }
}

function showPane(side, name) {
  for (const pane of document.querySelectorAll(`.side-${side} .pane`)) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

function setImage(img, src) {
  if (src && img.getAttribute('src') !== src) img.src = src;
}

function setupMessage(v) {
  switch (v.setupStep) {
    case 'code_sent': return '✓ Code sent. Enter it on the setup page (it’s in your Telegram chat).';
    case 'reading':
    case 'creating': return 'Getting your API key from Telegram…';
    case 'error': return `Setup problem: ${v.setupError || 'unknown error'}`;
    default: return 'Open the setup page to finish.';
  }
}

function errorMessage(error = '') {
  if (error.includes('API_ID_INVALID')) return 'Telegram rejected the API key. Log out of Telegram and set it up again.';
  if (error.includes('API_ID_PUBLISHED_FLOOD')) return 'Telegram blocked this API key. Log out of Telegram and set it up again.';
  if (!error) return 'Something went wrong.';
  return error.charAt(0).toUpperCase() + error.slice(1);
}

const STEP_ORDER = ['login', 'code', 'switching'];

function render(v) {
  document.body.dataset.state = v.state;
  const [title, sub] = headline(v);
  $('headline').textContent = title;
  $('sub').textContent = sub;

  const tgDone = TELEGRAM_DONE.has(v.state);
  const stDone = isStremioDone(v);
  const body = document.body.classList;
  body.toggle('tg-done', tgDone);
  body.toggle('st-done', stDone);
  body.toggle('pc-on', v.state === 'running');
  body.toggle('tg-active', ['qr', 'need_password', 'auto_setup', 'need_config'].includes(v.state));
  body.toggle('st-active', !stDone && v.stremio && v.stremio.state === 'waiting' && !!v.stremioQr);

  // Telegram side
  const tg = telegramPane(v);
  showPane('telegram', tg);
  if (tg === 'tg-qr') setImage($('tg-qr'), v.telegramQr);
  if (tg === 'tg-password') {
    $('password-hint').hidden = !v.hint;
    $('password-hint').textContent = v.hint ? `Hint: ${v.hint}` : '';
    if (document.activeElement !== $('password')) $('password').focus();
  }
  if (tg === 'tg-steps') {
    const at = STEP_ORDER.indexOf(v.setupStep === 'switching' ? 'switching' : 'code');
    document.querySelectorAll('.steps li').forEach((li) => {
      const i = STEP_ORDER.indexOf(li.dataset.step);
      li.classList.toggle('done', i < at);
      li.classList.toggle('active', i === at);
    });
  }
  if (tg === 'tg-setup') {
    $('setup-message').textContent = setupMessage(v);
    $('setup-message').classList.toggle('error', v.setupStep === 'error');
  }
  if (tg === 'tg-error') $('error-message').textContent = errorMessage(v.error);

  // Stremio side
  const st = stremioPane(v);
  showPane('stremio', st);
  if (st === 'st-qr') setImage($('st-qr'), v.stremioQr);
  if (st === 'st-error') $('stremio-error').textContent = (v.stremio && v.stremio.error) || 'Couldn’t reach Stremio.';
  if (st === 'st-done') {
    $('open-stremio').textContent = v.stremioInstalled ? 'Open Stremio' : 'Get Stremio';
    $('get-stremio-note').hidden = !!v.stremioInstalled;
  }
  $('manual').hidden = !(v.state === 'running' && !stDone && v.manifestUrl);
  $('manifest-url').textContent = v.manifestUrl || '';

  // Bars
  $('version').textContent = v.version ? `Version ${v.version}` : '';
  $('autostart-wrap').hidden = !v.canAutostart;
  $('autostart').checked = !!v.autostart;
  $('logout').hidden = !['running', 'starting_addon', 'error'].includes(v.state);
}

// Actions ------------------------------------------------------------------
$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const field = $('password');
  const value = field.value;
  field.value = '';
  await api.sendPassword(value);
});
$('connect-stremio').addEventListener('click', () => api.connectStremio());
$('open-stremio').addEventListener('click', () => api.openStremio());
$('open-setup').addEventListener('click', () => api.openSetupPage());
$('restart').addEventListener('click', () => api.restart());
$('restart-error').addEventListener('click', () => api.restart());
$('logout').addEventListener('click', () => api.logout());
// Log view: the end of the log file, refreshed while open.
let logTimer = null;
async function refreshLog(scrollToEnd) {
  const pre = $('log-text');
  const atEnd = scrollToEnd || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const text = (await api.getLog()) || 'Nothing logged yet.';
  if (text !== pre.textContent) pre.textContent = text;
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}
function showLog(open) {
  document.querySelector('main').hidden = open;
  $('log-view').hidden = !open;
  $('show-log').hidden = open;
  clearInterval(logTimer);
  if (open) {
    refreshLog(true);
    logTimer = setInterval(() => refreshLog(false), 1500);
    $('close-log').focus();
  } else {
    $('show-log').focus();
  }
}
$('show-log').addEventListener('click', () => showLog(true));
$('error-log').addEventListener('click', () => showLog(true));
$('close-log').addEventListener('click', () => showLog(false));
$('open-log-file').addEventListener('click', () => api.openLogs());
$('copy-log').addEventListener('click', async () => {
  await api.copyLog();
  $('copy-log').textContent = 'Copied';
  setTimeout(() => { $('copy-log').textContent = 'Copy'; }, 1500);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('log-view').hidden) showLog(false);
});
$('autostart').addEventListener('change', (e) => api.setAutostart(e.target.checked));
$('copy-address').addEventListener('click', async () => {
  const button = $('copy-address');
  if (await api.copyAddress()) {
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  }
});

window.render = render; // for screenshots of each screen (scripts, devtools)
api.onStatus(render);
