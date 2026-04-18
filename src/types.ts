// Shared types for the Telemedia → Stremio port.

export interface TgMediaRef {
  chatId: string;      // Telegram chat ID as decimal string (may be negative & very large — keep as string)
  messageId: number;
  fileSize: number;    // bytes, from document.size
  mimeType: string;
  fileName: string;
  duration?: number;
  width?: number;
  height?: number;
  dcId?: number;
}

export interface TgChatSummary {
  id: string;
  title: string;
  isChannel: boolean;
  isGroup: boolean;
  photoUrl?: string;
}

export type CatalogKind =
  | 'tg-dialogs'
  | 'tg-chat'
  | 'tmdb-movies'
  | 'tmdb-tv'
  | 'tg-kids'
  | 'tg-hebrew'
  | 'tg-world';

export interface StremioMetaPreview {
  id: string;
  type: 'movie' | 'series' | 'tv';
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface StremioMeta extends StremioMetaPreview {
  videos?: StremioVideo[];
  runtime?: string;
}

export interface StremioVideo {
  id: string;
  title: string;
  season?: number;
  episode?: number;
  released?: string;
  overview?: string;
  thumbnail?: string;
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url: string;
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    proxyHeaders?: Record<string, string>;
    filename?: string;
    videoSize?: number;
  };
}
