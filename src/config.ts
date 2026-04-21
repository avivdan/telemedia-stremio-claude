import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v == null || v === '' ? fallback : Number(v);
}

export const config = {
  telegram: {
    apiId: Number(req('TELEGRAM_API_ID')),
    apiHash: req('TELEGRAM_API_HASH'),
    session: process.env.TELEGRAM_SESSION ?? '',
    botUsername: opt('TG_BOT_USERNAME', ''),
  },
  server: {
    host: opt('ADDON_HOST', '127.0.0.1'),
    port: num('ADDON_PORT', 7000),
    publicBaseUrl: opt('PUBLIC_BASE_URL', 'http://127.0.0.1:7000'),
    streamBaseUrl: opt('STREAM_BASE_URL', process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:7000'),
  },
  tmdb: {
    apiKey: opt('TMDB_API_KEY', '34142515d9d23817496eeb4ff1d223d0'),
    imdbKey: opt('TMDB_IMDB_KEY', '653bb8af90162bd98fc7ee32bcbbfb3d'),
    language: opt('TMDB_LANGUAGE', 'he'),
  },
  chats: {
    kids: BigInt(opt('TG_KIDS_CHAT_ID', '-1001251653717')),
    hebrew: BigInt(opt('TG_HEBREW_GROUP', '-1001106800100')),
    world: BigInt(opt('TG_WORLD_GROUP', '-1001000750206')),
  },
  streaming: {
    chunkBytes: num('STREAM_CHUNK_KB', 512) * 1024,
    prefetchBytes: num('STREAM_PREFETCH_KB', 2048) * 1024,
  },
  cache: {
    ttlSeconds: num('CACHE_TTL_SECONDS', 900),
  },
  logLevel: opt('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
