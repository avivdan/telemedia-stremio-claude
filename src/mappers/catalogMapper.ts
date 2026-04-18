import { Api } from 'telegram';
import type { StremioMetaPreview, TgChatSummary } from '../types';
import { extractMedia } from '../api/telegram';
import { encodeMsgId, encodeChatId } from '../utils/ids';

// Turn a Telegram chat into a Stremio catalog item (series poster, dummy type).
export function chatToPreview(chat: TgChatSummary): StremioMetaPreview {
  return {
    id: encodeChatId(chat.id),
    type: 'series',
    name: chat.title,
    poster: chat.photoUrl,
    description: chat.isChannel ? 'Telegram channel' : 'Telegram group',
  };
}

// Turn a video message into a Stremio movie-style catalog item.
export function messageToPreview(msg: Api.Message): StremioMetaPreview | null {
  const media = extractMedia(msg);
  if (!media) return null;
  const name = stripExt(media.fileName);
  return {
    id: encodeMsgId(media.chatId, media.messageId),
    type: 'movie',
    name,
    description: msg.message?.slice(0, 400) || undefined,
    releaseInfo: new Date(msg.date * 1000).toISOString().slice(0, 10),
  };
}

function stripExt(name: string): string {
  return name.replace(/\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i, '');
}
