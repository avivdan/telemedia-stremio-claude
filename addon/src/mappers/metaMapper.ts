import { Api } from 'telegram';
import type { StremioMeta, StremioVideo } from '../types';
import { extractMedia } from '../api/telegram';
import { encodeMsgId } from '../utils/ids';

// One Telegram chat + a batch of video messages becomes a Stremio "series"
// with each message as an episode. This mirrors file_list() in default.py
// which shows a flat list of Videos under a chat.
export function chatToSeriesMeta(
  chatId: string,
  chatTitle: string,
  messages: Api.Message[],
): StremioMeta {
  const videos: StremioVideo[] = [];
  for (const msg of messages) {
    const media = extractMedia(msg);
    if (!media) continue;
    videos.push({
      id: encodeMsgId(chatId, msg.id),
      title: stripExt(media.fileName),
      released: new Date(msg.date * 1000).toISOString(),
      overview: msg.message?.slice(0, 400) ?? undefined,
      season: 1,
      episode: msg.id,   // use Telegram message id as episode number — monotonic
    });
  }
  return {
    id: `tgchat:${chatId}`,
    type: 'series',
    name: chatTitle,
    videos,
    description: `Telegram chat ${chatTitle}`,
  };
}

// A single Telegram video message → Stremio "movie" meta.
export function messageToMovieMeta(msg: Api.Message): StremioMeta | null {
  const media = extractMedia(msg);
  if (!media) return null;
  return {
    id: encodeMsgId(media.chatId, media.messageId),
    type: 'movie',
    name: stripExt(media.fileName),
    description: msg.message?.slice(0, 400) ?? undefined,
    releaseInfo: new Date(msg.date * 1000).toISOString().slice(0, 10),
    runtime: media.duration ? `${Math.round(media.duration / 60)} min` : undefined,
  };
}

function stripExt(name: string): string {
  return name.replace(/\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i, '');
}
