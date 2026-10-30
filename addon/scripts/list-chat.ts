// CLI to list video files in a specific Telegram chat.
//
// Run:  npm run list-chat -- <chatId> [query] [limit]
// Examples:
//   npm run list-chat -- -5290402488
//   npm run list-chat -- -5290402488 "האחרונים" 30
//   npm run list-chat -- -1001251653717 "" 50

import { getClient, extractMedia, fetchMessage } from '../src/api/telegram';
import { Api } from 'telegram';

async function main() {
  const chatId = process.argv[2];
  if (!chatId) {
    console.error('Usage: npm run list-chat -- <chatId> [query] [limit]');
    process.exit(1);
  }
  const query = process.argv[3] ?? '';
  const limit = Number(process.argv[4] ?? 50);

  const client = await getClient();
  console.log(`\n=== chat=${chatId} query="${query}" limit=${limit} ===\n`);

  const peer = await client.getInputEntity(String(chatId));
  const runSearch = async (filter: Api.TypeMessagesFilter, label: string) => {
    const res = await client.invoke(
      new Api.messages.Search({
        peer,
        q: query,
        filter,
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hash: (await import('big-integer')).default(0) as any,
      }),
    );
    const list = ((res as Api.messages.MessagesSlice).messages as Api.Message[]) ?? [];
    console.log(`[${label}] ${list.length} results`);
    return list;
  };

  const videoMsgs = await runSearch(new Api.InputMessagesFilterVideo(), 'Video filter');
  const docMsgs = await runSearch(new Api.InputMessagesFilterDocument(), 'Document filter');

  // Merge + dedupe by id
  const byId = new Map<number, Api.Message>();
  for (const m of [...videoMsgs, ...docMsgs]) {
    if (m.id != null) byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  console.log(`\ntotal unique: ${messages.length} messages\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const any = msg as unknown as {
      id?: number;
      message?: string;
      groupedId?: { toString(): string } | null;
      media?: { className?: string; document?: { className?: string } };
    };
    const media = extractMedia(msg);
    const captionPreview = (any.message ?? '').slice(0, 100).replace(/\n/g, ' ');

    console.log(`[${i + 1}] id=${any.id}`);
    console.log(`    media=${any.media?.className ?? 'none'} doc=${any.media?.document?.className ?? 'none'}`);
    console.log(`    groupedId=${any.groupedId?.toString() ?? 'none'}`);
    console.log(`    caption="${captionPreview}"`);
    if (media) {
      console.log(`    OK file="${media.fileName}" size=${(media.fileSize / 1024 / 1024).toFixed(1)}MB ${media.width ?? '?'}x${media.height ?? '?'} mime=${media.mimeType}`);
    } else if (any.id) {
      try {
        const fresh = await fetchMessage(chatId, any.id, true);
        const freshMedia = extractMedia(fresh);
        const freshAny = fresh as unknown as { message?: string; media?: { className?: string } };
        if (freshMedia) {
          console.log(`    REFETCH-OK file="${freshMedia.fileName}" size=${(freshMedia.fileSize / 1024 / 1024).toFixed(1)}MB`);
        } else {
          const text = (freshAny.message ?? '').slice(0, 100).replace(/\n/g, ' ');
          const isCopyright = /copyright|copyrighted|couldn't be displayed/i.test(text);
          console.log(`    REFETCH-NO-MEDIA media=${freshAny.media?.className ?? 'none'} copyright=${isCopyright}`);
          console.log(`    REFETCH-TEXT="${text}"`);
        }
      } catch (err) {
        console.log(`    REFETCH-FAILED: ${(err as Error).message}`);
      }
    }
    console.log('');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('list-chat failed:', err);
  process.exit(1);
});
