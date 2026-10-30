// debug_chat_messages.ts — drop into scripts/ and run with:
//   npx ts-node scripts/debug_chat_messages.ts

import { getClient } from '../src/api/telegram';
import { Api } from 'telegram';

const CHAT_ID = '-5290402488';

(async () => {
  const client = await getClient();

  const peer = await client.getInputEntity(CHAT_ID);

  const result = await client.invoke(
    new Api.messages.GetHistory({
      peer,
      limit: 20,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as any,
    })
  );

  const messages = (result as any).messages as Api.Message[];

  console.log(`\nLast ${messages.length} messages in chat ${CHAT_ID}:\n`);

  for (const msg of messages) {
    const hasMedia = !!msg.media;
    const mediaType = !msg.media ? 'none'
      : msg.media instanceof Api.MessageMediaDocument ? 'document'
      : msg.media instanceof Api.MessageMediaPhoto    ? 'photo'
      : msg.media?.className ?? 'other';

    const isVideo = msg.media instanceof Api.MessageMediaDocument
      && (msg.media.document as Api.Document)?.mimeType?.startsWith('video');

    console.log({
      id:        msg.id,
      date:      new Date(msg.date * 1000).toISOString(),
      text:      msg.message?.slice(0, 80) || '(empty)',
      hasMedia,
      mediaType,
      isVideo,
      groupedId: (msg as any).groupedId?.toString() ?? null,
    });
  }

  process.exit(0);
})();