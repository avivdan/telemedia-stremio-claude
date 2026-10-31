// Interactive Telegram sign-in for the desktop addon (`npm run login`).
// Replaces login.py's TDLib state machine; the result goes to the user config
// file (see userConfig.ts) — no .env to edit.
//
// Default: QR login, same as the TV app — a QR code is drawn in the terminal
// and scanned in Telegram on the phone (Settings → Devices → Link Desktop
// Device). `--phone` uses the phone-number + code flow instead.
//
// Kodi equivalents:
//   authorizationStateWaitPhoneNumber   → prompt("phone")
//   authorizationStateWaitCode          → prompt("code")
//   authorizationStateWaitPassword      → prompt("2FA password")
//   authorizationStateReady             → StringSession.save()

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import qrcode from 'qrcode-terminal';

export async function prompt(question: string, hidden = false): Promise<string> {
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

export interface LoginOptions {
  apiId: number;
  apiHash: string;
  method: 'qr' | 'phone';
}

// Returns the StringSession to store.
export async function interactiveLogin({ apiId, apiHash, method }: LoginOptions): Promise<string> {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  if (method === 'qr') {
    await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async ({ token }) => {
          console.clear();
          console.log('Scan with Telegram on your phone: Settings → Devices → Link Desktop Device\n');
          qrcode.generate(`tg://login?token=${token.toString('base64url')}`, { small: true });
          console.log('\n(The code refreshes automatically. Ctrl+C to cancel.)');
        },
        password: async (hint) => prompt(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `, true),
        onError: async (err) => {
          console.error('[login]', err.message);
          return true;
        },
      },
    );
  } else {
    await client.start({
      phoneNumber: async () => prompt('Phone number (international format): '),
      password: async () => prompt('2FA password (blank if none): ', true),
      phoneCode: async () => prompt('Login code from Telegram: '),
      onError: (err) => console.error('[login]', err),
    });
  }

  const session = (client.session as StringSession).save();
  await client.disconnect();
  return session;
}
