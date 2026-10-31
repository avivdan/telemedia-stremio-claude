// Meta handler.
//
// Our own ids only (the manifest leaves tt… details to Cinemeta):
//   tg:<chatId>:<messageId>    → one Telegram video (movie)
//   tgchat:<chatId>            → catalog of recent videos in chat (series)

import * as tg from '../api/telegram';
import { decodeMsgId, decodeChatId } from '../utils/ids';
import { chatToSeriesMeta, messageToMovieMeta } from '../mappers/metaMapper';
import type { StremioMeta } from '../types';
import { NotFoundError } from '../utils/errors';

export interface MetaArgs { type: string; id: string }

export async function metaHandler({ type, id }: MetaArgs): Promise<{ meta: StremioMeta }> {
  if (id.startsWith('tg:')) return { meta: await metaForTgMessage(id) };
  if (id.startsWith('tgchat:')) return { meta: await metaForTgChat(id) };
  // The manifest scopes meta to our own prefixes, so Stremio sends tt… ids to
  // Cinemeta. Older clients with a cached manifest may still ask — answer with
  // a minimal stub rather than a 404.
  return {
    meta: {
      id,
      type: (type === 'series' ? 'series' : 'movie') as StremioMeta['type'],
      name: '',
    },
  };
}

async function metaForTgMessage(id: string): Promise<StremioMeta> {
  const { chatId, messageId } = decodeMsgId(id);
  const msg = await tg.fetchMessage(chatId, messageId);
  const meta = messageToMovieMeta(msg);
  if (!meta) throw new NotFoundError(`No media in ${id}`);
  return meta;
}

async function metaForTgChat(id: string): Promise<StremioMeta> {
  const chatId = decodeChatId(id);
  const { messages } = await tg.searchChatVideos(chatId, '', 50);
  return chatToSeriesMeta(chatId, 'Telegram chat', messages);
}
