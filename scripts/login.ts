// One-shot CLI to produce a Telegram StringSession.
//
// Run:  npm run login
// Paste the resulting string into .env as TELEGRAM_SESSION=...
//
// This replaces login.py's xbmcgui.Dialog prompts with stdin prompts.

import { interactiveLogin } from '../src/api/auth';

(async () => {
  const session = await interactiveLogin();
  console.log('\n=== Copy the line below into .env ===\n');
  console.log(`TELEGRAM_SESSION=${session}`);
  console.log('\n=====================================');
})().catch((err) => {
  console.error('login failed:', err);
  process.exit(1);
});
