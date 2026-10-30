// CLI to run a Telegram global video search and dump results.
//
// Run:  npm run search -- "האחרונים מבינינו ע1 פ2"
//       npm run search -- "The Last of Us S01E02" 20
//
// Second arg = limit (default 40). Prints per-message: id, peer, filename,
// media className, doc className, caption preview, groupedId, and whether
// the media was copyright-stripped by Telegram.

import { getClient, globalSearchVideos, extractMedia, fetchMessage } from '../src/api/telegram';
import { Api } from 'telegram';

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: npm run search -- "<query>" [limit]');
    process.exit(1);
  }
  const limit = Number(process.argv[3] ?? 40);

  await getClient();
  console.log(`\n=== query: "${query}" (limit=${limit}) ===\n`);

  const msgs = await globalSearchVideos(query, limit);
  console.log(`total: ${msgs.length} messages\n`);

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const any = msg as unknown as {
      id?: number;
      className?: string;
      message?: string;
      groupedId?: { toString(): string } | null;
      media?: { className?: string; document?: { className?: string } };
      peerId?: {
        className?: string;
        channelId?: { toString(): string };
        chatId?: { toString(): string };
        userId?: { toString(): string };
      };
    };
    const peer =
      any.peerId?.channelId?.toString() ??
      any.peerId?.chatId?.toString() ??
      any.peerId?.userId?.toString() ??
      'none';
    const media = extractMedia(msg);
    const captionPreview = (any.message ?? '').slice(0, 80).replace(/\n/g, ' ');

    console.log(`[${i + 1}] id=${any.id} peer=${peer}`);
    console.log(`    media=${any.media?.className ?? 'none'} doc=${any.media?.document?.className ?? 'none'}`);
    console.log(`    groupedId=${any.groupedId?.toString() ?? 'none'}`);
    console.log(`    caption="${captionPreview}"`);

    if (media) {
      console.log(`    OK file="${media.fileName}" size=${(media.fileSize / 1024 / 1024).toFixed(1)}MB ${media.width}x${media.height}`);
    } else if (any.peerId?.channelId && any.id) {
      // Try refetch to see if stub or real stripped
      try {
        const fresh = await fetchMessage(
          `-100${any.peerId.channelId.toString()}`,
          any.id,
          true,
        );
        const freshMedia = extractMedia(fresh);
        const freshAny = fresh as unknown as { message?: string; media?: { className?: string } };
        if (freshMedia) {
          console.log(`    REFETCH-OK file="${freshMedia.fileName}" size=${(freshMedia.fileSize / 1024 / 1024).toFixed(1)}MB`);
        } else {
          const text = (freshAny.message ?? '').slice(0, 80).replace(/\n/g, ' ');
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

  // Peer breakdown
  const byPeer = new Map<string, number>();
  for (const m of msgs) {
    const any = m as unknown as { peerId?: { channelId?: { toString(): string } } };
    const p = any.peerId?.channelId?.toString() ?? 'none';
    byPeer.set(p, (byPeer.get(p) ?? 0) + 1);
  }
  console.log('=== peer breakdown ===');
  for (const [p, n] of [...byPeer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  peer=${p} count=${n}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('search failed:', err);
  process.exit(1);
});
