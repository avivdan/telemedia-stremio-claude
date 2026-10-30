// HTTP streaming proxy. This is the direct equivalent of
// service.py's RangeHTTPRequestHandler.send_head() — the beating heart of the
// Kodi addon. Stremio (like Kodi) will issue Range requests on our URL, we
// pull the exact byte slice from Telegram, and stream it back.
//
// Reference behavior in service.py (lines 652-1040):
//   GET /<file_id>
//     parse Range: bytes=s-e
//     td_send downloadFile(offset=s, limit=e, priority=1)
//     wait for updateFile chunks until enough bytes are on disk
//     self.send_response(206)
//     self.send_header Content-Type video/mp4
//     self.send_header Accept-Ranges bytes
//     self.send_header Content-Range bytes s-e/total
//     self.send_header Content-Length (e-s)
//     stream bytes from the local partial file
//
// In Node, gramjs's iterDownload() does the offset/limit math for us and
// streams chunks. We just splice and pipe them through the HTTP response.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config';
import { log } from '../utils/logger';
import * as tg from '../api/telegram';
import { extractMedia } from '../api/telegram';

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
  messageId: number,
): Promise<void> {
  let msg;
  try {
    msg = await tg.fetchMessage(chatId, messageId);
  } catch (err) {
    log.warn('fetchMessage failed', chatId, messageId, (err as Error).message);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const media = extractMedia(msg);
  if (!media) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Message has no media');
    return;
  }
  const size = media.fileSize;

  // Parse Range (service.py:944). Missing header → full 200.
  const rangeHeader = (req.headers.range as string | undefined) ?? '';
  let start = 0;
  let end = size - 1;
  let partial = false;

  if (rangeHeader) {
    const m = RANGE_RE.exec(rangeHeader);
    if (!m) {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
      });
      res.end();
      return;
    }
    const s = m[1];
    const e = m[2];
    if (s === '' && e !== '') {
      // suffix range: last N bytes
      start = Math.max(0, size - Number(e));
      end = size - 1;
    } else {
      start = Number(s);
      end = e ? Math.min(size - 1, Number(e)) : size - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    partial = true;
  }

  const length = end - start + 1;
  const headers: Record<string, string> = {
    'Content-Type': media.mimeType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${encodeURIComponent(media.fileName)}"`,
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(partial ? 206 : 200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  // Pull bytes from Telegram and pipe them to the client. If the client
  // disconnects mid-stream we abort the iterator (service.py used `stop_now`
  // for the same purpose, line 968).
  let aborted = false;
  const onClose = () => { aborted = true; };
  req.on('close', onClose);

  try {
    for await (const chunk of tg.iterDownload(
      media,
      msg,
      start,
      end + 1,
      config.streaming.chunkBytes,
    )) {
      if (aborted) break;
      const canContinue = res.write(chunk);
      if (!canContinue) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    log.warn('stream error', (err as Error).message);
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
