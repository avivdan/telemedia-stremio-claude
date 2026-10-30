import { searchChatVideos } from '../src/api/telegram';

const chatID = '-5290402488';

(async () => {
  const { messages } = await searchChatVideos(chatID, '', 100);
  console.log(messages.length);
  for (const m of messages) console.log(m.id, m.message?.slice(0, 120) ?? '');
  process.exit(0);
})();