// Catalog handler. Maps directly to the top-level sections of default.py:
//
//   main_menu()         → Movies / TV Shows / My Groups / Kids / Hebrew / World
//   movies_menu()       → TMDB popular / now playing / genre  (we just ship popular)
//   tv_show_menu()      → TMDB popular TV
//   my_groups()         → listDialogs()
//   chat catalog        → messages in a specific chat (Kids/Hebrew/World etc.)

import { config } from '../config';
import * as tmdb from '../api/tmdb';
import * as tg from '../api/telegram';
import { chatToPreview, messageToPreview } from '../mappers/catalogMapper';
import { makeCache, cached } from '../utils/cache';
import type { StremioMetaPreview } from '../types';
import { log } from '../utils/logger';

const cache = makeCache<StremioMetaPreview[]>(200);

export interface CatalogArgs {
  type: string;
  id: string;
  extra?: { search?: string; skip?: string; genre?: string };
}

export async function catalogHandler({ type, id, extra }: CatalogArgs) {
  const key = `${type}|${id}|${extra?.search ?? ''}|${extra?.skip ?? '0'}`;
  const metas = await cached(cache, key, () => resolveCatalog(type, id, extra));
  return { metas };
}

async function resolveCatalog(
  type: string,
  id: string,
  extra?: CatalogArgs['extra'],
): Promise<StremioMetaPreview[]> {
  log.info('catalog', { type, id, extra });
  switch (id) {
    case 'telemedia-movies':
      return extra?.search
        ? tmdb.searchTmdb(extra.search, 'movie')
        : tmdb.popularMovies(1 + Math.floor(Number(extra?.skip ?? 0) / 20));
    case 'telemedia-series':
      return extra?.search
        ? tmdb.searchTmdb(extra.search, 'tv')
        : tmdb.popularTv(1 + Math.floor(Number(extra?.skip ?? 0) / 20));
    case 'telemedia-my-groups': {
      const dialogs = await tg.listDialogs(100);
      return dialogs.map(chatToPreview);
    }
    case 'telemedia-kids':
      return listChatVideos(String(config.chats.kids), extra?.search ?? '');
    case 'telemedia-hebrew':
      return listChatVideos(String(config.chats.hebrew), extra?.search ?? '');
    case 'telemedia-world':
      return listChatVideos(String(config.chats.world), extra?.search ?? '');
    default: {
      // telemedia-prov-<providerId>-<movie|series>
      const m = /^telemedia-prov-(\d+)-(movie|series)$/.exec(id);
      if (m) {
        const providerId = Number(m[1]);
        const kind = m[2] === 'movie' ? 'movie' : 'tv';
        const page = 1 + Math.floor(Number(extra?.skip ?? 0) / 20);
        return tmdb.discoverByProvider(kind, providerId, page);
      }
      return [];
    }
  }
}

async function listChatVideos(chatId: string, query: string) {
  if (!chatId || chatId === '0') return [];
  try {
    const { messages } = await tg.searchChatVideos(chatId, query, 50);
    return messages.map(messageToPreview).filter((x): x is StremioMetaPreview => !!x);
  } catch (err) {
    log.warn('chat catalog failed', chatId, (err as Error).message);
    return [];
  }
}
