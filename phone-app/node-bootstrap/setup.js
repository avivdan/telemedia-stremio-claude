// Fully automatic first-run setup with the bundled starter key, the phone
// version of tv-app/node-bootstrap/starter-login.js:
//   1. The user logs in with the starter key on this phone (login.js).
//   2. Ask my.telegram.org for a login code for the account's own number.
//      Telegram delivers it to the "Telegram" chat (777000); read it there.
//   3. Read (or create) the account's own api_id/api_hash (my-telegram.js,
//      shared with the TV app).
//   4. Log in under the own key by approving its login token from the starter
//      session, then log the starter session out.
// The starter key is only used for these few minutes; the addon always runs
// on the user's own key.

'use strict';

const myTelegram = require('./tv/my-telegram');
const { parseCode } = require('./tv/starter-login');
const { connectOrThrow } = require('./login');

const SERVICE_USER_ID = '777000'; // the "Telegram" chat that delivers login codes
const CODE_TIMEOUT = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorText(err) {
  return String(err && (err.errorMessage || err.message) ? err.errorMessage || err.message : err);
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

// starterClient: logged in with the starter key (login.js).
// password(): the two-step password typed during that login, if any.
// Resolves { apiId, apiHash, session } — session is missing when only the
// last step failed (the caller then logs in again with the own key).
// Throws if the own keys could not be fetched.
async function fetchOwnKeys({ starterClient, starter, onStep, askPassword, password }) {
  const { TelegramClient, Api } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  let keepStarter = false;
  try {
    onStep('code');
    const me = await starterClient.getMe();
    const phone = myTelegram.normalizePhone('+' + me.phone);
    if (!phone) throw new Error('Telegram did not tell us the account\'s phone number');
    const before = await latestServiceMessage(starterClient);
    const pending = await myTelegram.sendCode(phone);
    const code = await waitForCode(starterClient, before ? before.id : 0);
    console.log('[setup] my.telegram.org code received');

    const keys = await myTelegram.fetchKeys(pending, code, onStep);
    console.log(`[setup] own API keys ${keys.created ? 'created' : 'read'}`);
    const result = { apiId: keys.apiId, apiHash: keys.apiHash };

    // Same app as the starter key (its owner's own account): keep this login.
    if (String(keys.apiId) === String(starter.apiId)) {
      result.session = starterClient.session.save();
      keepStarter = true;
      return result;
    }

    onStep('switching');
    try {
      const own = new TelegramClient(new StringSession(''), Number(keys.apiId), keys.apiHash, {
        connectionRetries: 5,
      });
      let reuse = password();
      let wrong = false;
      try {
        await connectOrThrow(own); // inside the try: the client is destroyed even if this fails
        await own.signInUserWithQrCode(
          { apiId: Number(keys.apiId), apiHash: keys.apiHash },
          {
            // What a phone does when it scans a QR code: approve the token
            // from the session that is already logged in.
            qrCode: async ({ token }) => {
              await starterClient.invoke(new Api.auth.AcceptLoginToken({ token }));
            },
            // The password from the first login; ask again only if it's rejected.
            password: async (hint) => {
              if (reuse) {
                const pw = reuse;
                reuse = undefined;
                return pw;
              }
              return askPassword(hint, wrong);
            },
            onError: async (err) => {
              console.log('[setup] own-key login error: ' + errorText(err));
              if (/PASSWORD_HASH_INVALID/.test(errorText(err))) {
                wrong = true;
                return false;
              }
              return true;
            },
          },
        );
        result.session = own.session.save();
      } finally {
        await own.destroy().catch(() => {});
      }
    } catch (err) {
      console.log('[setup] could not log in with the own key: ' + errorText(err));
    }
    return result;
  } finally {
    // Don't keep the starter login around, even after a failure.
    if (!keepStarter) await starterClient.invoke(new Api.auth.LogOut()).catch(() => {});
    await starterClient.destroy().catch(() => {});
  }
}

module.exports = { fetchOwnKeys };
