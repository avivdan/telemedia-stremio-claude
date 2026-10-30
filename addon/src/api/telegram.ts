// Telegram client wrapper. Replaces TDLib + service.py's td_send/td_receive pair.
//
// Kodi reference points:
//   login.py              → authentication state machine
//   service.py RPC        → getFile / downloadFile / getChats / searchChatMessages
//   default.py infiniteReceiver / file_list / search
//
// We use gramjs (MTProto in pure TS) because it:
//   - runs on plain Node without native binaries (no dll/so per platform)
//   - exposes Api.messages.search, GetDialogs, iterDownload for range reads

import { TelegramClient, Api, errors } from 'telegram';
import { StringSession } from 'telegram/sessions';
import bigInt from 'big-integer';
import { config } from '../config';
import { log } from '../utils/logger';
import type { TgChatSummary, TgMediaRef } from '../types';

let singleton: TelegramClient | null = null;

// In-process message cache: populated by globalSearchVideos / searchChatVideos.
// Keyed by "chatId:messageId". The proxy checks here before calling the API,
// which avoids re-fetching messages from channels the user isn't a member of.
const msgCache = new Map<string, Api.Message>();

export function cacheMessage(msg: Api.Message): void {
  const chatId = String(getPeerId(msg.peerId));
  msgCache.set(`${chatId}:${msg.id}`, msg);
}

export function getCachedMessage(chatId: string, messageId: number): Api.Message | undefined {
  return msgCache.get(`${chatId}:${messageId}`);
}

export async function getClient(): Promise<TelegramClient> {
  if (singleton) return singleton;
  if (!config.telegram.session) {
    throw new Error(
      'TELEGRAM_SESSION is empty. Run `npm run login` first to generate one.',
    );
  }
  const client = new TelegramClient(
    new StringSession(config.telegram.session),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5, useWSS: false },
  );
  await client.connect();
  const me = await client.getMe();
  log.info('Telegram connected as', 'id' in me ? String(me.id) : '(unknown)');
  singleton = client;
  return client;
}

// ---------------------------------------------------------------------------
// Chats (my_groups / infiniteReceiver)
// ---------------------------------------------------------------------------
export async function listDialogs(limit = 100): Promise<TgChatSummary[]> {
  const client = await getClient();
  const dialogs = await client.getDialogs({ limit });
  return dialogs
    .filter((d) => d.isGroup || d.isChannel)
    .map<TgChatSummary>((d) => ({
      id: String(d.id),
      title: d.title ?? 'Untitled',
      isChannel: !!d.isChannel,
      isGroup: !!d.isGroup,
    }));
}

// ---------------------------------------------------------------------------
// Message search inside one chat (file_list in default.py:1480)
// Telegram filter: InputMessagesFilterVideo
// ---------------------------------------------------------------------------
export async function searchChatVideos(
  chatId: string | bigint,
  query: string,
  limit = 50,
  offsetId = 0,
): Promise<{ messages: Api.Message[]; lastId: number }> {
  const client = await getClient();
  const peer = await client.getInputEntity(String(chatId));

  // Run both Video + Document filters. Many uploaders attach video files as
  // documents (drag-drop in desktop app) which Video filter misses entirely.
  const runOne = async (filter: Api.TypeMessagesFilter) => {
    const res = await client.invoke(
      new Api.messages.Search({
        peer,
        q: query,
        filter,
        minDate: 0,
        maxDate: 0,
        offsetId,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );
    return (res as Api.messages.MessagesSlice).messages as Api.Message[];
  };
  const [vids, docs] = await Promise.all([
    runOne(new Api.InputMessagesFilterVideo()),
    runOne(new Api.InputMessagesFilterDocument()),
  ]);

  // Dedupe by id. Filter docs for video mime types only.
  const byId = new Map<number, Api.Message>();
  for (const m of vids) if (m.id != null) byId.set(m.id, m);
  for (const m of docs) {
    if (m.id == null || byId.has(m.id)) continue;
    const media = m.media;
    if (
      media instanceof Api.MessageMediaDocument &&
      media.document instanceof Api.Document &&
      (media.document.mimeType ?? '').startsWith('video/')
    ) {
      byId.set(m.id, m);
    }
  }
  const messages = [...byId.values()].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  messages.forEach(cacheMessage);
  const lastId = messages.length ? Number(messages[messages.length - 1].id) : 0;
  return { messages, lastId };
}

// Global search across all the user's dialogs (default.py:1283 search()).
// Cached because stream resolution fires many variant queries per request and
// Stremio retries stream lookups — without a cache we trip FLOOD_WAIT fast.
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { at: number; msgs: Api.Message[] }>();

export async function globalSearchVideos(
  query: string,
  limit = 50,
): Promise<Api.Message[]> {
  const key = `${limit}|${query.trim().toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    return hit.msgs;
  }
  const client = await getClient();

  // Run both Video + Document filters globally; many uploaders attach files
  // as documents (mime=video/*) which Video filter misses.
  const runOne = async (filter: Api.TypeMessagesFilter) => {
    const res = await client.invoke(
      new Api.messages.SearchGlobal({
        q: query,
        filter,
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit,
      }),
    );
    return (res as Api.messages.MessagesSlice).messages as Api.Message[];
  };
  const [vids, docs] = await Promise.all([
    runOne(new Api.InputMessagesFilterVideo()),
    runOne(new Api.InputMessagesFilterDocument()),
  ]);

  const byId = new Map<string, Api.Message>();
  const keyOf = (m: Api.Message): string => {
    const pid = m.peerId as unknown as {
      channelId?: { toString(): string };
      chatId?: { toString(): string };
      userId?: { toString(): string };
    } | undefined;
    const p = pid?.channelId?.toString() ?? pid?.chatId?.toString() ?? pid?.userId?.toString() ?? 'x';
    return `${p}:${m.id}`;
  };
  for (const m of vids) byId.set(keyOf(m), m);
  for (const m of docs) {
    const k = keyOf(m);
    if (byId.has(k)) continue;
    const media = m.media;
    if (
      media instanceof Api.MessageMediaDocument &&
      media.document instanceof Api.Document &&
      (media.document.mimeType ?? '').startsWith('video/')
    ) {
      byId.set(k, m);
    }
  }
  const messages = [...byId.values()];
  messages.forEach(cacheMessage);
  searchCache.set(key, { at: Date.now(), msgs: messages });
  if (searchCache.size > 200) {
    const oldestKey = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldestKey) searchCache.delete(oldestKey);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Media extraction from a message (file_id / c_id / m_id in Kodi terms)
// ---------------------------------------------------------------------------
export function extractMedia(msg: Api.Message): TgMediaRef | null {
  const m = msg.media;
  if (!m) return null;
  if (m instanceof Api.MessageMediaDocument && m.document instanceof Api.Document) {
    const doc = m.document;
    const attrs = doc.attributes ?? [];
    const fname =
      (attrs.find((a) => a instanceof Api.DocumentAttributeFilename) as
        | Api.DocumentAttributeFilename
        | undefined)?.fileName ?? `tg_${msg.id}.mp4`;
    const video = attrs.find((a) => a instanceof Api.DocumentAttributeVideo) as
      | Api.DocumentAttributeVideo
      | undefined;
    return {
      chatId: String(getPeerId(msg.peerId)),
      messageId: msg.id,
      fileSize: Number(doc.size),
      mimeType: doc.mimeType ?? 'video/mp4',
      fileName: fname,
      duration: video?.duration,
      width: video?.w,
      height: video?.h,
      dcId: doc.dcId,
    };
  }
  return null;
}

export async function fetchMessage(
  chatId: string | bigint,
  messageId: number,
  skipCache = false,
): Promise<Api.Message> {
  // Check the in-process cache first — populated by search results, which
  // may include messages from channels the user isn't a member of.
  // skipCache=true forces a fresh API fetch (used when cached entry has no media).
  if (!skipCache) {
    const cached = getCachedMessage(String(chatId), messageId);
    if (cached) return cached;
  }

  const client = await getClient();

  // Try channels.GetMessages first (works for channels/supergroups).
  // Fall back to messages.GetMessages for regular groups/chats.
  let msg: Api.Message | undefined;
  try {
    const peer = await client.getInputEntity(String(chatId));
    const res = await client.invoke(
      new Api.channels.GetMessages({
        channel: peer as unknown as Api.InputChannel,
        id: [new Api.InputMessageID({ id: messageId })],
      }),
    );
    const list = (res as Api.messages.MessagesSlice).messages;
    msg = list.find((m): m is Api.Message => m instanceof Api.Message && m.id === messageId);
  } catch {
    const res = await client.invoke(
      new Api.messages.GetMessages({
        id: [new Api.InputMessageID({ id: messageId })],
      }),
    );
    const list = (res as Api.messages.MessagesSlice).messages;
    msg = list.find((m): m is Api.Message => m instanceof Api.Message && m.id === messageId);
  }

  if (!msg) throw new Error(`Message ${chatId}/${messageId} not found`);
  cacheMessage(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Range-aware streaming download. This is the Node equivalent of
// service.py's send_head() → downloadFile(offset, limit) → wait_download_file
// pipeline.
//
// We call upload.getFile ourselves instead of gramjs's iterDownload: gramjs
// issues one request at a time (throughput ≈ request size / round-trip,
// ~1 MB/s on the TV — below a 1080p bitrate), caps requests at 512 KiB, and
// from unaligned offsets its "indirect" path re-downloads up to half of every
// chunk. Here: 1 MiB block-aligned requests (≈2x throughput), `parallel` of
// them in flight, yielded in order.
// ---------------------------------------------------------------------------
const MAX_REQUEST_BYTES = 1024 * 1024;

// upload.getFile rules: limit is a multiple of 4 KiB that divides 1 MiB, and
// a request must not cross a 1 MiB boundary. A power of two in [4 KiB, 1 MiB]
// used on limit-aligned offsets satisfies both.
function requestSizeFor(bytes: number): number {
  let size = 4096;
  while (size * 2 <= Math.min(bytes, MAX_REQUEST_BYTES)) size *= 2;
  return size;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function* iterDownload(
  media: TgMediaRef,
  msg: Api.Message,
  start: number,
  end: number,            // exclusive
  chunkBytes: number,
  parallel = config.streaming.parallel,
): AsyncGenerator<Buffer> {
  const client = await getClient();
  const doc = (msg.media as Api.MessageMediaDocument).document as Api.Document;
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: '',
  });
  const reqSize = requestSizeFor(chunkBytes);
  let sender = await client.getSender(media.dcId ?? doc.dcId);

  const fetchBlock = async (offset: number): Promise<Buffer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await client.invokeWithSender(
          new Api.upload.GetFile({ location, offset: bigInt(offset), limit: reqSize }),
          sender,
        );
        if (!(res instanceof Api.upload.File)) throw new Error('CDN redirect not supported');
        return Buffer.from(res.bytes);
      } catch (err) {
        if (err instanceof errors.FileMigrateError) {
          sender = await client.getSender(err.newDc);
        } else if (err instanceof errors.FloodWaitError) {
          await sleep(err.seconds * 1000);
        } else if (attempt < 2) {
          await sleep(500 * (attempt + 1));
        } else {
          throw err;
        }
      }
    }
  };

  // Blocks still to deliver, in order. Each promise gets a no-op catch so a
  // prefetch failing while we await an earlier block isn't an unhandled
  // rejection; awaiting it below still throws.
  const inflight: Promise<Buffer>[] = [];
  let nextOffset = Math.floor(start / reqSize) * reqSize;
  let blockOffset = nextOffset;
  const fill = () => {
    while (inflight.length < Math.max(1, parallel) && nextOffset < end) {
      const p = fetchBlock(nextOffset);
      p.catch(() => {});
      inflight.push(p);
      nextOffset += reqSize;
    }
  };

  fill();
  while (inflight.length) {
    const block = await inflight.shift()!;
    fill();
    const from = Math.max(start - blockOffset, 0);
    const to = Math.min(end - blockOffset, block.length);
    if (to > from) yield block.subarray(from, to);
    blockOffset += reqSize;
    if (block.length < reqSize) break; // end of file
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function getPeerId(peer: Api.TypePeer | undefined): string | number {
  if (!peer) return 0;
  if (peer instanceof Api.PeerChannel) return String(-1000000000000n - BigInt(peer.channelId.toString()));
  if (peer instanceof Api.PeerChat) return String(-BigInt(peer.chatId.toString()));
  if (peer instanceof Api.PeerUser) return String(peer.userId);
  return 0;
}
