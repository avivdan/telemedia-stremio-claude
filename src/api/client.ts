// Thin HTTP client mirroring resources/modules/client.py (base_header + get_html).
// Used for TMDB and any plain-HTTP resolver we might add later.
//
// The Kodi file juggled urllib / urllib2 / cookielib for Python 2 vs 3. Here we
// just wrap axios and expose the same header contract.

import axios, { AxiosRequestConfig } from 'axios';
import { log } from '../utils/logger';

export const baseHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  Pragma: 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:59.0) Gecko/20100101 Firefox/59.0',
};

export async function getJson<T>(url: string, cfg: AxiosRequestConfig = {}): Promise<T> {
  try {
    const { data } = await axios.get<T>(url, {
      timeout: 20_000,
      headers: { ...baseHeaders, ...(cfg.headers ?? {}) },
      ...cfg,
    });
    return data;
  } catch (err) {
    log.warn('HTTP error:', url, (err as Error).message);
    throw err;
  }
}

export const http = { getJson };
