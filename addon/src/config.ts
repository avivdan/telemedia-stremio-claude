// Configuration — no .env file. Each setting comes from, in order:
//   1. an environment variable (CI, Docker, the Android TV app, overrides)
//   2. the user config file written by `npm run login` (see userConfig.ts)
//   3. the built-in default below

import { readUserConfig, resolveSetting } from './userConfig';

const file = readUserConfig();
const get = (name: string) => resolveSetting(name, process.env, file);
const str = (name: string, fallback: string) => get(name) ?? fallback;
const num = (name: string, fallback: number) => {
  const v = get(name);
  return v == null ? fallback : Number(v);
};

export const config = {
  // Missing credentials don't fail at import (the login script needs to load
  // this before they exist); the Telegram client checks them when connecting.
  telegram: {
    apiId: num('TELEGRAM_API_ID', 0),
    apiHash: str('TELEGRAM_API_HASH', ''),
    session: str('TELEGRAM_SESSION', ''),
    botUsername: str('TG_BOT_USERNAME', ''),
  },
  server: {
    host: str('ADDON_HOST', '127.0.0.1'),
    port: num('ADDON_PORT', 7000),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://127.0.0.1:7000'),
    streamBaseUrl: str('STREAM_BASE_URL', str('PUBLIC_BASE_URL', 'http://127.0.0.1:7000')),
  },
  // Streaming-service rows (JustWatch): availability country and title language.
  catalog: {
    country: str('CATALOG_COUNTRY', 'IL'),
    language: str('CATALOG_LANGUAGE', 'he'),
  },
  chats: {
    kids: BigInt(str('TG_KIDS_CHAT_ID', '-1001251653717')),
    hebrew: BigInt(str('TG_HEBREW_GROUP', '-1001106800100')),
    world: BigInt(str('TG_WORLD_GROUP', '-1001000750206')),
  },
  streaming: {
    // Telegram upload.getFile request size; 1 MiB (the max) ≈ 2x the
    // throughput of 512 KiB.
    chunkBytes: num('STREAM_CHUNK_KB', 1024) * 1024,
    prefetchBytes: num('STREAM_PREFETCH_KB', 2048) * 1024,
    // upload.getFile requests kept in flight per stream. More than ~2 on one
    // connection triggers Telegram throttling (bursty, often slower overall).
    parallel: num('STREAM_PARALLEL', 2),
  },
  cache: {
    ttlSeconds: num('CACHE_TTL_SECONDS', 900),
  },
  logLevel: str('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
