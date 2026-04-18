import { LRUCache } from 'lru-cache';
import { config } from '../config';

// Parallels resources/modules/cache.py — simple keyed TTL cache.
// We keep it in-memory; the Kodi addon used SQLite but that was mostly
// for offline resume persistence we don't need here.
export function makeCache<T extends NonNullable<unknown>>(max = 500) {
  return new LRUCache<string, T>({
    max,
    ttl: config.cache.ttlSeconds * 1000,
  });
}

export async function cached<T extends NonNullable<unknown>>(
  bag: LRUCache<string, T>,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = bag.get(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  bag.set(key, value);
  return value;
}
