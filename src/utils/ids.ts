// ID encoding used across manifest / catalog / meta / stream / proxy.
//
// Telegram messages are addressed by (chatId, messageId). We pack them into a
// single Stremio-friendly string so they round-trip through URL segments.
//
// For reference, default.py passes the same pair around inside JSON blobs
// like `{"c_id": <chat_id>, "m_id": <message_id>, "id": <file_id>}`.

const PREFIX = 'tg';

export function encodeMsgId(chatId: string | bigint, messageId: number): string {
  return `${PREFIX}:${String(chatId)}:${messageId}`;
}

export function decodeMsgId(id: string): { chatId: string; messageId: number } {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new Error(`Not a Telegram message id: ${id}`);
  }
  return { chatId: parts[1], messageId: Number(parts[2]) };
}

export function encodeChatId(chatId: string | bigint): string {
  return `${PREFIX}chat:${String(chatId)}`;
}

export function decodeChatId(id: string): string {
  if (!id.startsWith(`${PREFIX}chat:`)) {
    throw new Error(`Not a Telegram chat id: ${id}`);
  }
  return id.slice(`${PREFIX}chat:`.length);
}
