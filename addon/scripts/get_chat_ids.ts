// list Telegram dialogs for testing purposes
import { listDialogs } from '../src/api/telegram';
(async () => {
  const d = await listDialogs(200);
  for (const c of d) console.log(c.id, '\t', c.title);
})();