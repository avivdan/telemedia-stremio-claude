import type { StremioStream, TgMediaRef } from '../types';
import { config } from '../config';

// Telegram filenames are often URL-encoded (e.g. "Avatar%20Fire%20and%20Ash.mp4")
// or have underscores instead of spaces. Produce a readable display name.
function decodeFilename(raw: string): string {
  let s = raw;
  try { s = decodeURIComponent(s); } catch { /* malformed % — keep raw */ }
  return s.replace(/_/g, ' ');
}

// Build the Stremio stream record. The `url` points at our own proxy, which
// in turn streams from Telegram with Range support — exactly how
// service.py serves http://127.0.0.1:<port>/<file_id>.
export function mediaToStream(media: TgMediaRef): StremioStream {
  const qualityTag = media.height ? `${media.height}p` : 'SD';
  const sizeGb = (media.fileSize / (1024 * 1024 * 1024)).toFixed(2);
  const decoded = decodeFilename(media.fileName);
  const ext = (decoded.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '.mp4').toLowerCase();
  const safeName = decoded.replace(/[\r\n]/g, ' ');
  const url = `${config.server.streamBaseUrl}/stream/${encodeURIComponent(
    media.chatId,
  )}/${media.messageId}/video${ext}`;

  return {
    name: `Telemedia ${qualityTag}`,
    title: `${safeName} | ${sizeGb} GB`,
    url,
    behaviorHints: {
      bingeGroup: `tg-${media.chatId}`,
      filename: safeName,
      videoSize: media.fileSize,
    },
  };
}
