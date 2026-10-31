// Catalog handler. Maps directly to the top-level sections of default.py:
//
//   main_menu()         → My Groups / Kids / Hebrew / World + streaming-service rows
//   movies_menu() / tv_show_menu() → not ported: Stremio's Cinemeta already
//                         shows popular movies/series, and we stream for those ids
//   my_groups()         → listDialogs()
//   chat catalog        → messages in a specific chat (Kids/Hebrew/World etc.)

import { config } from '../config';
import * as tg from '../api/telegram';
import { hebrewSearch } from '../api/hebrewSearch';
import { popularOnProvider } from '../api/justwatch';
import { HEBREW_SEARCH_CATALOG, PROVIDERS } from '../manifest';
import { hasHebrew } from '../search/matching';
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
    case HEBREW_SEARCH_CATALOG:
      return hebrewSearchCatalog(type, extra?.search ?? '');
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
      // telemedia-prov-<providerId>-<movie|series>. Unknown ids — e.g. the
      // removed Movies/TV catalogs, still listed in manifests cached by
      // Stremio — return nothing.
      const m = /^telemedia-prov-(\d+)-(movie|series)$/.exec(id);
      const provider = m && PROVIDERS.find((p) => p.id === Number(m[1]));
      if (!provider) return [];
      try {
        return await popularOnProvider(provider.jw, m![2] as 'movie' | 'series', Number(extra?.skip ?? 0));
      } catch (err) {
        log.warn('provider catalog failed', id, (err as Error).message);
        return [];
      }
    }
  }
}

// Stremio's search box sends every query to every search catalog; only act on
// Hebrew text (English names are already covered by Cinemeta).
async function hebrewSearchCatalog(type: string, query: string): Promise<StremioMetaPreview[]> {
  if (!hasHebrew(query)) return [];
  try {
    const hits = await hebrewSearch(query);
    return hits
      .filter((h) => h.type === type)
      .map((h) => ({
        id: h.imdbId,
        type: h.type,
        name: h.name,
        poster: `https://images.metahub.space/poster/medium/${h.imdbId}/img`,
        releaseInfo: h.year ? String(h.year) : undefined,
        description: h.enName && h.enName !== h.name ? h.enName : undefined,
      }));
  } catch (err) {
    log.warn('hebrew search failed', query, (err as Error).message);
    return [];
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
