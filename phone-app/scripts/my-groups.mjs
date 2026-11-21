// Lists the Telegram groups and channels of the account logged in on the
// phone, to choose the head-start groups (groups.txt) from. Over adb; the
// phone must be connected and Telemedia running.
//
// Run:  npm run my-groups [-- <adb serial>]             public + private chats
//       npm run my-groups -- --invites [<adb serial>]   invite links for the
//                                                       private ones, read-only
// Only public chats (t.me link) or invite links can be suggested to others.

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The control server only answers the app, or a short-lived developer token
// that adb puts into the app's own external folder (Android 11+; Telemedia
// accepts it for 15 minutes). Removed again at the end.
const token = randomBytes(24).toString('hex');
const DEV_FILE = '/sdcard/Android/data/com.telemedia.phone/files/dev-token';

const args = process.argv.slice(2);
const invites = args.includes('--invites');
const serial = args.find((a) => !a.startsWith('--')) || process.env.PHONE_ADB_SERIAL || '';
const adb = (cmd) => execSync(`adb ${serial ? `-s ${serial} ` : ''}${cmd}`, { encoding: 'utf8' }).trim();
const LOCAL = 17001;

const local = mkdtempSync(join(tmpdir(), 'telemedia-'));
writeFileSync(join(local, 'dev-token'), token);
adb(`push "${join(local, 'dev-token')}" ${DEV_FILE}`);
rmSync(local, { recursive: true, force: true });
adb(`forward tcp:${LOCAL} tcp:7001`);
const unforward = () => {
  try {
    adb(`forward --remove tcp:${LOCAL}`);
  } catch {
    // already gone
  }
  try {
    adb(`shell rm -f ${DEV_FILE}`);
  } catch {
    // already gone
  }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { unforward(); process.exit(130); });
try {
  console.log(invites
    ? 'Looking for invite links of your private chats (a minute or two)...'
    : 'Asking the phone (can take a minute: it counts videos per public chat)...');
  const res = await fetch(`http://127.0.0.1:${LOCAL}/${invites ? 'chats/invites' : 'chats'}`, {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json', 'X-Telemedia-Token': token },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

  if (invites) {
    const withLink = body.chats.filter((c) => c.link);
    console.log(`\nPrivate chats with an invite link: ${withLink.length} of ${body.chats.length}`);
    for (const c of withLink) console.log(`  ${c.link.padEnd(40)} ${c.title}  (${c.how})`);
    console.log('\nNo invite link found:');
    for (const c of body.chats.filter((x) => !x.link)) console.log(`  ${c.title}${c.channel ? '  (channel)' : ''}`);
  } else {
    const chats = body.chats.sort((a, b) => (b.videos ?? -1) - (a.videos ?? -1));
    const pub = chats.filter((c) => c.link);
    console.log(`\nPublic (can be suggested): ${pub.length}`);
    for (const c of pub) {
      const facts = [
        c.channel ? 'channel' : 'group',
        c.members ? `${c.members} members` : null,
        c.videos != null ? `${c.videos} videos` : null,
        c.files != null ? `${c.files} files` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ${c.link.padEnd(36)} ${c.title}  (${facts})`);
    }
    const priv = chats.filter((c) => !c.link);
    console.log(`\nPrivate (need an invite link: npm run my-groups -- --invites): ${priv.length}`);
    for (const c of priv) console.log(`  ${c.title}${c.channel ? '  (channel)' : ''}`);
  }
} finally {
  unforward();
}
