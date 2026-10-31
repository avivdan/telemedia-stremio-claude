// One-time Telegram login for the desktop addon. Saves the API ID/hash and
// the session to the user config file — nothing to copy or paste.
//
// Run:  npm run login            (QR code in the terminal)
//       npm run login -- --phone (phone number + code instead)

import { interactiveLogin, prompt } from '../src/api/auth';
import { readUserConfig, resolveSetting, writeUserConfig } from '../src/userConfig';

(async () => {
  const file = readUserConfig();
  let apiId = Number(resolveSetting('TELEGRAM_API_ID', process.env, file) ?? 0);
  let apiHash = resolveSetting('TELEGRAM_API_HASH', process.env, file) ?? '';
  if (!apiId || !apiHash) {
    console.log('Telegram API credentials are needed once (https://my.telegram.org → API development tools).');
    apiId = Number(await prompt('API ID: '));
    apiHash = (await prompt('API hash: ')).trim();
  }

  const method = process.argv.includes('--phone') ? 'phone' : 'qr';
  const session = await interactiveLogin({ apiId, apiHash, method });
  const saved = writeUserConfig({ apiId, apiHash, session });
  console.log(`\nLogged in. Saved to ${saved}`);
  console.log('Start the addon with: npm start');
})().catch((err) => {
  console.error('login failed:', err);
  process.exit(1);
});
