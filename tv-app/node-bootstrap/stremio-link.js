// Adds the Telemedia addon to the user's Stremio account — no typing on the TV.
//
// Stremio has no API for another app to install an addon into the Stremio
// app, but addons live in the user's Stremio *account* and the Stremio app
// syncs them. So:
//   1. Get a pairing code from Stremio's own "link" login (the same flow its
//      TV app uses) and show it as a QR code.
//   2. The user scans it with the phone camera and confirms on link.stremio.com.
//   3. With the resulting session key: read the account's addon collection,
//      add/update Telemedia, write it back, verify — then log that session out.
//
// The collection API replaces the whole list in one call, so we never write
// unless we successfully read a non-empty list (Stremio always keeps its
// protected official addons in it).

'use strict';

const LINK_API = 'https://link.stremio.com/api';
const API = 'https://api.strem.io/api';
const CODE_TTL_MS = 10 * 60 * 1000; // ask for a fresh code after this
const POLL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init) {
  const res = await fetch(url, init);
  return res.json();
}

async function api(method, body) {
  const json = await getJson(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (json.error) throw new Error(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

// Pure: the collection with Telemedia added or refreshed. Returns null when
// nothing needs writing (already installed with the same manifest version).
function mergeAddonCollection(addons, transportUrl, manifest) {
  const entry = { transportUrl, transportName: '', manifest, flags: { official: false, protected: false } };
  const idx = addons.findIndex(
    (a) => a.transportUrl === transportUrl || (a.manifest && a.manifest.id === manifest.id),
  );
  if (idx === -1) return [...addons, entry];
  const cur = addons[idx];
  if (cur.transportUrl === transportUrl && cur.manifest && cur.manifest.version === manifest.version) return null;
  // Same addon id from elsewhere (e.g. an old tunnel URL) or an older version:
  // replace in place, keep its position.
  return addons.map((a, i) => (i === idx ? { ...a, ...entry } : a));
}

async function installAddon(authKey, transportUrl, manifest) {
  const before = await api('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  const addons = before && before.addons;
  if (!Array.isArray(addons) || addons.length === 0) {
    throw new Error('could not read your Stremio addons — nothing was changed');
  }
  const next = mergeAddonCollection(addons, transportUrl, manifest);
  if (!next) return 'already-installed';
  await api('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: next });
  const after = await api('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  const saved = after && Array.isArray(after.addons) ? after.addons : [];
  const names = (list) => list.map((a) => (a.manifest && a.manifest.name) || a.transportUrl).join(', ');
  console.log(`[stremio-link] addons before (${addons.length}): ${names(addons)}`);
  console.log(`[stremio-link] addons after  (${saved.length}): ${names(saved)}`);
  if (!saved.some((a) => a.transportUrl === transportUrl)) throw new Error('Stremio did not save the addon');
  if (saved.length < addons.length) throw new Error('Stremio addon list shrank unexpectedly');
  return 'installed';
}

// Runs the pairing loop until the addon is in the account (or the host says
// Stremio already uses it). `host` supplies:
//   isConnected()      → true once Stremio is known to use the addon
//   whenAddonReady()   → Promise<{ manifestUrl }> resolving once the addon serves
//   markConnected()    → persist "connected"
//   onStatus(s)        → { state: 'waiting'|'installing'|'done'|'error', link?, error? }
async function run(host) {
  const log = (m) => console.log('[stremio-link] ' + m);
  while (!host.isConnected()) {
    let code;
    let link;
    try {
      const created = await getJson(`${LINK_API}/create?type=Create`);
      code = created.result && created.result.code;
      link = created.result && created.result.link;
      if (!code || !link) throw new Error('no code');
    } catch (err) {
      host.onStatus({ state: 'error', error: 'Stremio is unreachable, retrying…' });
      await sleep(30_000);
      continue;
    }
    host.onStatus({ state: 'waiting', link });

    let authKey = null;
    const deadline = Date.now() + CODE_TTL_MS;
    while (!authKey && Date.now() < deadline) {
      await sleep(POLL_MS);
      if (host.isConnected()) return host.onStatus({ state: 'done' });
      try {
        // Until confirmed this answers error 101 "Invalid or expired token".
        const read = await getJson(`${LINK_API}/read?type=Read&code=${encodeURIComponent(code)}`);
        authKey = read.result && read.result.authKey;
      } catch {
        // network hiccup — keep polling
      }
    }
    if (!authKey) continue; // code expired → new code

    host.onStatus({ state: 'installing' });
    try {
      const { manifestUrl } = await host.whenAddonReady();
      const manifest = await getJson(manifestUrl);
      const result = await installAddon(authKey, manifestUrl, manifest);
      log(result);
      host.markConnected();
      host.onStatus({ state: 'done' });
      return;
    } catch (err) {
      log('install failed: ' + err.message);
      host.onStatus({ state: 'error', error: err.message });
      await sleep(10_000);
    } finally {
      // The pairing created a session just for us; end it, keep nothing.
      api('logout', { type: 'Logout', authKey }).catch(() => {});
    }
  }
  host.onStatus({ state: 'done' });
}

module.exports = { run, mergeAddonCollection };
