// Entry point. Combines:
//   - Stremio addon SDK (manifest + catalog/meta/stream)
//   - Our own HTTP server for /stream/<chatId>/<messageId> Range proxy
//
// Both live on the same port. We build a Node HTTP server manually so we can
// own the Range route; the Stremio SDK's getInterface().get() produces an
// Express-compatible handler that we mount as the fallback.

import http from 'node:http';
import { addonBuilder, getRouter } from 'stremio-addon-sdk';
import { manifest } from './manifest';
import { catalogHandler } from './handlers/catalog';
import { metaHandler } from './handlers/meta';
import { streamHandler } from './handlers/stream';
import { handleStream as handleProxy } from './handlers/proxy';
import { getClient } from './api/telegram';
import { config } from './config';
import { log } from './utils/logger';

async function main() {
  // Boot Telegram first so failures surface before HTTP is live.
  await getClient();

  const builder = new addonBuilder(manifest as never);
  builder.defineCatalogHandler(catalogHandler as never);
  builder.defineMetaHandler(metaHandler as never);
  builder.defineStreamHandler(streamHandler as never);

  const sdkRouter = getRouter(builder.getInterface());

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    // Range proxy: /stream/<chatId>/<messageId>
    const m = /^\/stream\/([^/]+)\/(\d+)(?:\/[^?]*)?(?:\?.*)?$/.exec(url);
    if (m) {
      const chatId = decodeURIComponent(m[1]);
      const messageId = Number(m[2]);
      handleProxy(req, res, chatId, messageId).catch((err) => {
        log.error('proxy handler crashed', err);
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end();
      });
      return;
    }

    // Simple health probe — handy when debugging.
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Everything else → Stremio SDK (manifest.json, /catalog, /meta, /stream).
    sdkRouter(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
  });

  server.listen(config.server.port, config.server.host, () => {
    log.info(
      `Telemedia addon listening on http://${config.server.host}:${config.server.port}`,
    );
    // 0.0.0.0 is a bind-only address — print a URL the user can actually click.
    const displayHost =
      config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
    log.info(
      `Install in Stremio:  http://${displayHost}:${config.server.port}/manifest.json`,
    );
    if (config.server.host === '0.0.0.0') {
      log.info('LAN devices: use your PC\'s IP in place of 127.0.0.1');
    }
  });
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
