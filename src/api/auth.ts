// Replaces login.py's TDLib state machine with a single-shot gramjs sign-in.
//
// Kodi equivalents:
//   authorizationStateWaitPhoneNumber   → prompt("phone")
//   authorizationStateWaitCode          → prompt("code")
//   authorizationStateWaitPassword      → prompt("2FA password")
//   authorizationStateReady             → StringSession.save()
//
// We cannot keep this flow inside the Stremio handler (Stremio has no
// interactive UI) so the user runs `npm run login` once in a terminal.

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../config';

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input, output });
  if (hidden) {
    // Disable local echo for password entry
    (output as NodeJS.WriteStream).write(question);
    const answer = await new Promise<string>((resolve) => {
      let buf = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === '\n' || c === '\r') {
          (output as NodeJS.WriteStream).write('\n');
          (input as NodeJS.ReadStream).setRawMode(false);
          input.removeListener('data', onData);
          resolve(buf);
        } else if (c === '\u0003') {
          process.exit();
        } else {
          buf += c;
        }
      };
      (input as NodeJS.ReadStream).setRawMode(true);
      input.resume();
      input.on('data', onData);
    });
    rl.close();
    return answer;
  }
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

export async function interactiveLogin(): Promise<string> {
  const client = new TelegramClient(
    new StringSession(''),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 },
  );

  await client.start({
    phoneNumber: async () => prompt('Phone number (international format): '),
    password: async () => prompt('2FA password (blank if none): ', true),
    phoneCode: async () => prompt('Login code from Telegram: '),
    onError: (err) => console.error('[login]', err),
  });

  const session = (client.session as StringSession).save();
  await client.disconnect();
  return session;
}
