// Head-start groups: a list of suggested Telegram groups/channels, set at
// build time (defaults.json "groups", see scripts/bundle-node.mjs), that a new
// user can join with one tap so Telemedia finds videos right away. Nothing is
// joined unless the user confirms in the app.
//
// Accepted entries (one per line, or all on one line comma-separated;
// "# comment"; an optional note after " | "):
//   @name   t.me/name   https://t.me/name   tg://resolve?domain=name
//   t.me/+HASH   t.me/joinchat/HASH   tg://join?invite=HASH   (invite links)

'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorText(err) {
  return String(err && (err.errorMessage || err.message) ? err.errorMessage || err.message : err);
}

// One link → { kind: 'username', username } | { kind: 'invite', hash } | null
function parseGroupLink(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  let m = /^tg:\/\/resolve\?(?:.*&)?domain=([A-Za-z0-9_]+)/i.exec(s);
  if (m) return { kind: 'username', username: m[1] };
  m = /^tg:\/\/join\?(?:.*&)?invite=([A-Za-z0-9_-]+)/i.exec(s);
  if (m) return { kind: 'invite', hash: m[1] };
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, 't.me/');
  m = /^t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)\/?$/i.exec(s);
  if (m) return { kind: 'invite', hash: m[1] };
  m = /^(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(s);
  if (m) return { kind: 'username', username: m[1] };
  return null;
}

// The whole build-time list → [{ link, note, kind, username|hash }].
// Throws on an entry it can't read, so a typo fails the build, not the app.
function parseGroupList(text) {
  const out = [];
  const seen = new Set();
  // One entry per line; a single line may list several, comma-separated.
  const all = String(text || '');
  const lines = /[\r\n]/.test(all) ? all.split(/\r?\n/) : all.split(',');
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [link, ...rest] = line.split(/\s+\|\s+/);
    const parsed = parseGroupLink(link);
    if (!parsed) throw new Error(`head-start groups: can't read "${link}" (use t.me/name, @name or an invite link)`);
    const key = parsed.kind === 'username' ? '@' + parsed.username.toLowerCase() : '+' + parsed.hash;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ link: link.trim(), note: rest.join(' | ').trim(), ...parsed });
  }
  return out;
}

// Title, size and "already a member?" for one entry, without joining.
async function describe(client, entry) {
  const { Api } = require('telegram');
  const base = { link: entry.link, note: entry.note || '' };
  try {
    if (entry.kind === 'username') {
      const res = await client.invoke(new Api.contacts.ResolveUsername({ username: entry.username }));
      const chat = (res.chats || [])[0];
      if (!chat) return { ...base, error: 'not a group or channel' };
      return {
        ...base,
        title: chat.title,
        channel: !!chat.broadcast,
        members: chat.participantsCount || undefined,
        joined: chat.left === false,
      };
    }
    const res = await client.invoke(new Api.messages.CheckChatInvite({ hash: entry.hash }));
    if (res instanceof Api.ChatInviteAlready) {
      return { ...base, title: res.chat.title, channel: !!res.chat.broadcast, joined: true };
    }
    if (res instanceof Api.ChatInvitePeek) {
      return { ...base, title: res.chat.title, channel: !!res.chat.broadcast, joined: false };
    }
    return {
      ...base,
      title: res.title,
      channel: !!res.broadcast,
      members: res.participantsCount || undefined,
      joined: false,
      approval: !!res.requestNeeded,
    };
  } catch (err) {
    const text = errorText(err);
    console.log(`[groups] can't look up ${entry.link}: ${text}`);
    return {
      ...base,
      error: /INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(text)
        ? 'link no longer works'
        : 'could not load',
    };
  }
}

// Joins one entry → 'joined' | 'requested' (needs an admin's approval) | 'already'.
async function join(client, entry) {
  const { Api } = require('telegram');
  try {
    if (entry.kind === 'username') {
      const res = await client.invoke(new Api.contacts.ResolveUsername({ username: entry.username }));
      const chat = (res.chats || [])[0];
      if (!chat) throw new Error('not a group or channel');
      await client.invoke(new Api.channels.JoinChannel({ channel: chat }));
    } else {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: entry.hash }));
    }
    return 'joined';
  } catch (err) {
    const text = errorText(err);
    if (/USER_ALREADY_PARTICIPANT/.test(text)) return 'already';
    if (/INVITE_REQUEST_SENT/.test(text)) return 'requested';
    if (/CHANNELS_TOO_MUCH/.test(text)) throw new Error('You are in too many groups and channels.\nTelegram doesn\'t allow more.');
    if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/.test(text)) throw new Error('The invite link no longer works.');
    throw new Error(text);
  }
}

// Joins the chosen entries one by one (a pause between, so Telegram doesn't
// rate-limit). onProgress(results) after each. Resolves the results by link.
async function joinAll(client, entries, onProgress = () => {}) {
  const results = {};
  for (const [i, entry] of entries.entries()) {
    if (i) await sleep(1500);
    try {
      results[entry.link] = { result: await join(client, entry) };
    } catch (err) {
      console.log(`[groups] join ${entry.link} failed: ${err.message}`);
      results[entry.link] = { error: err.message };
    }
    onProgress({ ...results });
  }
  return results;
}

// The groups and channels this account is in, to pick head-start groups from
// (npm run my-groups). Only public ones (with a t.me link) can be suggested
// to others; for those, also how many videos / files they have.
async function listMyChats(client) {
  const { Api } = require('telegram');
  const bigInt = require('big-integer');
  const count = async (peer, filter) => {
    try {
      const r = await client.invoke(new Api.messages.Search({
        peer, q: '', filter, minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0,
        limit: 1, maxId: 0, minId: 0, hash: bigInt(0),
      }));
      return typeof r.count === 'number' ? r.count : (r.messages || []).length;
    } catch {
      return null;
    }
  };
  const out = [];
  for (const d of await client.getDialogs({ limit: 300 })) {
    if (!d.isGroup && !d.isChannel) continue;
    const e = d.entity || {};
    const username = e.username || (e.usernames || []).map((u) => u.username).find(Boolean) || null;
    const chat = { title: d.title || '', link: username ? 't.me/' + username : null, channel: !!e.broadcast };
    if (e.participantsCount) chat.members = e.participantsCount;
    if (username) {
      chat.videos = await count(e, new Api.InputMessagesFilterVideo());
      chat.files = await count(e, new Api.InputMessagesFilterDocument());
      await sleep(300);
    }
    out.push(chat);
  }
  return out;
}

// Invite links for the account's private groups/channels, read-only:
//   1. the chat's own invite link, when this account may see it (admins);
//   2. invite links posted in the account's chats (e.g. channel directories),
//      matched to a private chat with checkChatInvite (which doesn't join).
// Nothing is created: no new invite links in other people's groups.
async function findInvites(client) {
  const { Api } = require('telegram');
  const wanted = [];
  for (const d of await client.getDialogs({ limit: 300 })) {
    const e = d.entity || {};
    if ((!d.isGroup && !d.isChannel) || e.username || (e.usernames || []).length) continue;
    wanted.push({ id: String(e.id), title: d.title || '', channel: !!e.broadcast, entity: e });
  }
  const found = new Map();

  for (const w of wanted) {
    try {
      const full = w.entity.className === 'Chat'
        ? await client.invoke(new Api.messages.GetFullChat({ chatId: w.entity.id }))
        : await client.invoke(new Api.channels.GetFullChannel({ channel: w.entity }));
      const link = full.fullChat && full.fullChat.exportedInvite && full.fullChat.exportedInvite.link;
      if (link) found.set(w.id, { link, how: 'chat info' });
    } catch {
      // not allowed: try the next way
    }
    await sleep(300);
  }

  const hashes = new Set();
  for (const q of ['', 't.me', 'joinchat']) {
    try {
      const res = await client.invoke(new Api.messages.SearchGlobal({
        q, filter: new Api.InputMessagesFilterUrl(), minDate: 0, maxDate: 0, offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit: 100,
      }));
      for (const m of res.messages || []) {
        const texts = [m.message || ''];
        for (const ent of m.entities || []) if (ent.url) texts.push(ent.url);
        for (const row of (m.replyMarkup && m.replyMarkup.rows) || []) {
          for (const b of row.buttons || []) if (b.url) texts.push(b.url);
        }
        for (const t of texts) {
          for (const mm of t.matchAll(/t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]{8,})/g)) hashes.add(mm[1]);
        }
      }
    } catch (err) {
      console.log('[groups] search: ' + errorText(err));
    }
  }
  console.log(`[groups] ${hashes.size} invite links seen in chats`);

  let checks = 0;
  for (const hash of hashes) {
    if (checks++ >= 40 || wanted.every((w) => found.has(w.id))) break;
    try {
      const r = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
      const chat = r.chat;
      const match = chat
        ? wanted.find((w) => w.id === String(chat.id))
        : wanted.find((w) => w.title && w.title === r.title);
      if (match && !found.has(match.id)) found.set(match.id, { link: 'https://t.me/+' + hash, how: 'posted in a chat' });
    } catch (err) {
      if (/FLOOD/.test(errorText(err))) break;
    }
    await sleep(1500);
  }
  return wanted.map((w) => ({ title: w.title, channel: w.channel, ...(found.get(w.id) || { link: null }) }));
}

module.exports = { parseGroupLink, parseGroupList, describe, join, joinAll, listMyChats, findInvites };
