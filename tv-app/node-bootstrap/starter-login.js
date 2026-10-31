// Fully automatic first-run setup, used when the build bundles a starter API
// key (defaults.json "starter", see bundle-node.mjs):
//   1. QR login with the starter key — the user scans one code in Telegram.
//   2. Ask my.telegram.org for a login code for the account's own phone
//      number. Telegram delivers it to the "Telegram" chat; read it there.
//   3. Read (or create) the account's own api_id/api_hash (my-telegram.js).
//   4. Log in under the own key by approving its login token from the starter
//      session (what a phone does when it scans a QR code), then log the
//      starter session out.
// The starter key is only used for these few minutes; the addon always runs
// on the user's own key.

'use strict';

const myTelegram = require('./my-telegram');

const SERVICE_USER_ID = '777000'; // the "Telegram" chat that delivers login codes
const CODE_TIMEOUT = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "…This is your login code:\nAbC1dEf2GhI…" → "AbC1dEf2GhI"
function parseCode(text) {
  return (String(text || '').match(/login code:?\s*([A-Za-z0-9_-]{6,})/i) || [])[1] || null;
}

// The newest message in the "Telegram" chat. A fresh session knows no chats
// yet, so go through the dialog list instead of looking the chat up by id.
async function latestServiceMessage(client) {
  const dialogs = await client.getDialogs({ limit: 30 });
  const chat = dialogs.find((d) => d.entity && String(d.entity.id) === SERVICE_USER_ID);
  return chat && chat.message ? chat.message : null;
}

async function waitForCode(client, afterId) {
  const deadline = Date.now() + CODE_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(3000);
    const msg = await latestServiceMessage(client);
    const code = msg && msg.id > afterId ? parseCode(msg.message) : null;
    if (code) return code;
  }
  throw new Error('The my.telegram.org login code did not arrive in the "Telegram" chat');
}

function errorText(err) {
  return String(err && (err.errorMessage || err.message) ? err.errorMessage || err.message : err);
}

// Resolves { apiId, apiHash, session } — session is missing when only the
// last step failed, and the caller falls back to a normal QR login with the
// user's own key. Throws if the own keys could not be fetched.
async function run({ starter, onQr, askPassword, onStep }) {
  const { TelegramClient, Api } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const connect = async (apiId, apiHash) => {
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 5 });
    await client.connect();
    return client;
  };
  // A wrong two-step password asks again; anything else ends the login.
  const onError = async (err) => {
    console.log('[starter] login error: ' + errorText(err));
    return !/PASSWORD_HASH_INVALID/.test(errorText(err));
  };
  // Both logins need the two-step password; the user types it once.
  let lastPassword;
  const typePassword = async (hint) => (lastPassword = await askPassword(hint));

  const starterClient = await connect(starter.apiId, starter.apiHash);
  let keepStarter = false;
  try {
    await starterClient.signInUserWithQrCode(
      { apiId: Number(starter.apiId), apiHash: starter.apiHash },
      {
        qrCode: async ({ token, expires }) => onQr('tg://login?token=' + token.toString('base64url'), expires),
        password: typePassword,
        onError,
      },
    );

    onStep('code');
    const me = await starterClient.getMe();
    const phone = myTelegram.normalizePhone('+' + me.phone);
    if (!phone) throw new Error('Telegram did not tell us the account\'s phone number');
    const before = await latestServiceMessage(starterClient);
    const pending = await myTelegram.sendCode(phone);
    const code = await waitForCode(starterClient, before ? before.id : 0);
    console.log('[starter] my.telegram.org code received');

    const keys = await myTelegram.fetchKeys(pending, code, onStep);
    console.log(`[starter] own API keys ${keys.created ? 'created' : 'read'}`);
    const result = { apiId: keys.apiId, apiHash: keys.apiHash };

    // Same app as the starter key (its owner's own account): keep this login.
    if (String(keys.apiId) === String(starter.apiId)) {
      result.session = starterClient.session.save();
      keepStarter = true;
      return result;
    }

    onStep('switching');
    try {
      const own = await connect(keys.apiId, keys.apiHash);
      let reuse = lastPassword;
      try {
        await own.signInUserWithQrCode(
          { apiId: Number(keys.apiId), apiHash: keys.apiHash },
          {
            qrCode: async ({ token }) => {
              await starterClient.invoke(new Api.auth.AcceptLoginToken({ token }));
            },
            // The password from the first login; ask again only if it's rejected.
            password: async (hint) => {
              if (reuse === undefined) return typePassword(hint);
              const pw = reuse;
              reuse = undefined;
              return pw;
            },
            onError,
          },
        );
        result.session = own.session.save();
      } finally {
        await own.disconnect().catch(() => {});
      }
    } catch (err) {
      console.log('[starter] could not log in with the own key: ' + errorText(err));
    }
    return result;
  } finally {
    // Don't keep the starter login around, even after a failure.
    if (!keepStarter) await starterClient.invoke(new Api.auth.LogOut()).catch(() => {});
    await starterClient.disconnect().catch(() => {});
  }
}

module.exports = { run, parseCode };
