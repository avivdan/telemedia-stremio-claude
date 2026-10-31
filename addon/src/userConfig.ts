// The user config file — replaces the old hand-edited .env.
//
// Written by `npm run login` (Telegram API ID/hash + session); optional
// `settings` hold overrides keyed like the environment variables
// (e.g. "CATALOG_COUNTRY": "US"). Never committed: it lives in the user's
// config directory, not the repo.
//
//   Windows: %APPDATA%\telemedia\config.json
//   macOS/Linux: $XDG_CONFIG_HOME/telemedia/config.json (~/.config/…)
//   override: TELEMEDIA_CONFIG=/path/to/config.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UserConfig {
  apiId?: number;
  apiHash?: string;
  session?: string;
  settings?: Record<string, string | number | boolean>;
}

export function userConfigPath(): string {
  if (process.env.TELEMEDIA_CONFIG) return process.env.TELEMEDIA_CONFIG;
  let base: string;
  if (process.platform === 'win32' && process.env.APPDATA) {
    base = process.env.APPDATA;
  } else if (process.env.XDG_CONFIG_HOME) {
    base = process.env.XDG_CONFIG_HOME;
  } else {
    let home = '';
    try {
      home = os.homedir();
    } catch {
      // some embedded runtimes have no home directory
    }
    base = path.join(home || '.', '.config');
  }
  return path.join(base, 'telemedia', 'config.json');
}

export function readUserConfig(): UserConfig {
  try {
    return JSON.parse(fs.readFileSync(userConfigPath(), 'utf8')) as UserConfig;
  } catch {
    return {};
  }
}

export function writeUserConfig(patch: UserConfig): string {
  const file = userConfigPath();
  const next = { ...readUserConfig(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Holds the Telegram session (full account access): owner-only where supported.
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return file;
}

// Pure: one setting by its environment-variable name. Environment wins, then
// the config file (top-level credentials or `settings`), else undefined.
export function resolveSetting(
  name: string,
  env: NodeJS.ProcessEnv,
  file: UserConfig,
): string | undefined {
  const fromEnv = env[name];
  if (fromEnv != null && fromEnv !== '') return fromEnv;
  const topLevel: Record<string, unknown> = {
    TELEGRAM_API_ID: file.apiId,
    TELEGRAM_API_HASH: file.apiHash,
    TELEGRAM_SESSION: file.session,
  };
  const v = topLevel[name] ?? file.settings?.[name];
  return v == null || v === '' ? undefined : String(v);
}
