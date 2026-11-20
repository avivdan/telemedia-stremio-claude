// Renders the app's status (from main.js) into the page. The page is static:
// render() only shows/hides panes and sets texts, so a half-typed password
// survives every update.
'use strict';

const $ = (id) => document.getElementById(id);
const api = window.telemedia;

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
$('open-logs').addEventListener('click', () => api.openLogs());
$('autostart').addEventListener('change', (e) => api.setAutostart(e.target.checked));
$('copy-address').addEventListener('click', async () => {
  const button = $('copy-address');
  if (await api.copyAddress()) {
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  }
});

api.onStatus(render);
