// The Stremio accounts this phone is connected to ("Connect a user"): adds the
// phone's LAN entry to an account, keeps it up to date when the phone's
// address or key changes, and removes it again ("Remove"). Same mechanism as
// the TV app's stremio-link.js (link.stremio.com login, then read / merge /
// write / verify the account's addon collection; mergeAddonCollection()
// reused), but the session key is kept on the phone (app-private) until the
// account is removed.
//
// The collection API replaces the whole list in one call, so we never write
// unless we read a non-empty list, we only ever touch our own entries, and we
// verify the result.

'use strict';

const { mergeAddonCollection } = require('./tv/stremio-link');

const LINK_API = 'https://link.stremio.com/api';
const API = 'https://api.strem.io/api';
const CODE_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call to Stremio gives up after 20 s (a slow network must not leave
// an action hanging).
async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return res.json();
}

class StremioApiError extends Error {}

async function api(method, body) {
  const json = await getJson(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (json.error) throw new StremioApiError(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

// A session that no longer works (logged out, expired): ask the user again.
const isAuthError = (err) => err instanceof StremioApiError && /session|auth/i.test(err.message);

// { code, link }: the TV's owner opens link and confirms there.
async function createLink() {
  const created = await getJson(`${LINK_API}/create?type=Create`);
  const code = created.result && created.result.code;
  const link = created.result && created.result.link;
  if (!code || !link) throw new Error('Stremio is unreachable right now.');
  return { code, link };
}

// Polls until the user confirms → authKey; null when the code expired or
// stop() says to give up.
async function waitForLink(code, stop = () => false) {
  const deadline = Date.now() + CODE_TTL_MS;
  while (Date.now() < deadline && !stop()) {
    await sleep(POLL_MS);
    try {
      // Until confirmed this answers error 101 "Invalid or expired token".
      const read = await getJson(`${LINK_API}/read?type=Read&code=${encodeURIComponent(code)}`);
      if (read.result && read.result.authKey) return read.result.authKey;
    } catch {
      // network hiccup: keep polling
    }
  }
  return null;
}

// Which account a session belongs to → { id, email }.
async function getUser(authKey) {
  const user = await api('getUser', { type: 'GetUser', authKey });
  return { id: (user && user._id) || null, email: (user && user.email) || null };
}

async function readCollection(authKey) {
  const res = await api('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  const addons = res && res.addons;
  if (!Array.isArray(addons) || addons.length === 0) {
    throw new Error('could not read your Stremio addons, nothing was changed');
  }
  return addons;
}

async function writeCollection(authKey, next) {
  await api('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: next });
  const after = await api('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  return after && Array.isArray(after.addons) ? after.addons : [];
}

// Pure: the collection with each entry ({ transportUrl, manifest }) added or
// refreshed. replaces(addon) marks our own older entries of the same kind
// (another address, an older id): the first one is updated in place, any
// further copies dropped. Everything else is untouched. onlyReplace: never
// append (automatic updates must not bring back an entry the user removed).
function mergeEntries(addons, entries, replaces, onlyReplace = false) {
  let next = addons;
  for (const { transportUrl, manifest } of entries) {
    const old = replaces ? next.findIndex((a) => replaces(a)) : -1;
    if (old === -1 && onlyReplace) continue;
    if (old !== -1) {
      const cur = next[old];
      const m = cur.manifest || {};
      // mergeAddonCollection() only compares address and version; a new id
      // or name (same address) must be written too.
      const same = cur.transportUrl === transportUrl && m.id === manifest.id
        && m.name === manifest.name && m.version === manifest.version;
      const kept = next.filter((a, i) => i === old || !replaces(a)); // drop further copies
      if (same) {
        if (kept.length !== next.length) next = kept;
        continue;
      }
      next = kept.map((a) => (a === cur ? { ...a, transportUrl, manifest } : a));
      continue;
    }
    next = mergeAddonCollection(next, transportUrl, manifest) || next;
  }
  return next;
}

// Adds or refreshes entries, one write for all.
// → 'installed' | 'already-installed' | 'missing' (onlyReplace and none of
// ours is there anymore: the user removed it in Stremio).
async function putAddons(authKey, entries, { replaces, onlyReplace = false } = {}) {
  if (entries.some((e) => !e.transportUrl)) throw new Error('no address to write');
  const addons = await readCollection(authKey);
  if (onlyReplace && !(replaces && addons.some((a) => replaces(a)))) return 'missing';
  const next = mergeEntries(addons, entries, replaces, onlyReplace);
  if (next === addons) return 'already-installed';
  const saved = await writeCollection(authKey, next);
  for (const { transportUrl } of entries) {
    if (!saved.some((a) => a.transportUrl === transportUrl)) throw new Error('Stremio did not save the addon');
  }
  if (saved.length < next.length) throw new Error('Stremio addon list shrank unexpectedly');
  return 'installed';
}

// Removes the entries shouldRemove(addon) picks. → 'removed' | 'not-found'
async function removeAddons(authKey, shouldRemove) {
  const addons = await readCollection(authKey);
  const next = addons.filter((a) => !shouldRemove(a));
  if (next.length === addons.length) return 'not-found';
  const saved = await writeCollection(authKey, next);
  if (saved.some(shouldRemove)) throw new Error('Stremio did not remove the addon');
  if (saved.length < next.length) throw new Error('Stremio addon list shrank unexpectedly');
  return 'removed';
}

// The account's addons: name, id and transport host (no paths, so no keys).
async function listAddons(authKey) {
  return (await readCollection(authKey)).map((a) => {
    let host = '';
    try { host = new URL(a.transportUrl).host; } catch { /* not a URL */ }
    return { name: (a.manifest && a.manifest.name) || '', id: (a.manifest && a.manifest.id) || '', host };
  });
}

// Ends a session we no longer need.
const logout = (authKey) => api('logout', { type: 'Logout', authKey });

module.exports = {
  createLink,
  waitForLink,
  getUser,
  putAddons,
  removeAddons,
  mergeEntries,
  listAddons,
  logout,
  isAuthError,
};
