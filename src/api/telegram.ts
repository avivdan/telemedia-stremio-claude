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

import { TelegramClient, Api } from 'telegram';
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
  const res = await client.invoke(
    new Api.messages.Search({
      peer,
      q: query,
      filter: new Api.InputMessagesFilterVideo(),
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
  const messages = (res as Api.messages.MessagesSlice).messages as Api.Message[];
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
  const res = await client.invoke(
    new Api.messages.SearchGlobal({
      q: query,
      filter: new Api.InputMessagesFilterVideo(),
      minDate: 0,
      maxDate: 0,
      offsetRate: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      offsetId: 0,
      limit,
    }),
  );
  const messages = (res as Api.messages.MessagesSlice).messages as Api.Message[];
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
): Promise<Api.Message> {
  // Check the in-process cache first — populated by search results, which
  // may include messages from channels the user isn't a member of.
  const cached = getCachedMessage(String(chatId), messageId);
  if (cached) return cached;

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
// pipeline. gramjs already implements the slot/chunk machinery.
// ---------------------------------------------------------------------------
export async function* iterDownload(
  media: TgMediaRef,
  msg: Api.Message,
  start: number,
  end: number,            // exclusive
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  const client = await getClient();
  const doc = (msg.media as Api.MessageMediaDocument).document as Api.Document;
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: '',
  });

  // gramjs expects offsets aligned to 4 KiB. We align down and trim on the way out.
  const alignment = 4096;
  const alignedStart = Math.floor(start / alignment) * alignment;
  const skip = start - alignedStart;
  const length = end - start;
  let served = 0;

  const iter = client.iterDownload({
    file: location,
    offset: bigInt(alignedStart),
    limit: length + skip,
    requestSize: chunkBytes,
    dcId: media.dcId ?? doc.dcId,
  });

  for await (const raw of iter) {
    const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let slice = chunk;
    if (served === 0 && skip > 0) slice = slice.subarray(skip);
    const remaining = length - served;
    if (slice.length > remaining) slice = slice.subarray(0, remaining);
    if (slice.length > 0) {
      served += slice.length;
      yield slice;
    }
    if (served >= length) break;
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
