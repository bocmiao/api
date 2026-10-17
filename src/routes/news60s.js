import { accountRouter, requireAdmin } from './account.js';
import { news60sStore } from '../lib/news60s/store.js';
import { updateNews60s } from '../lib/news60s/update.js';
import { audit } from '../lib/audit.js';

// Mounted on the existing session-only, same-origin JSON/CSRF-checked admin router.
accountRouter.add('GET', '/admin/news/60s', (ctx) => {
  requireAdmin(ctx);
  return { data: news60sStore().status() };
});
accountRouter.add('POST', '/admin/news/60s/update', async (ctx) => {
  requireAdmin(ctx);
  const result = await updateNews60s(ctx.body);
  audit(ctx, 'news60s.publish', { target: result.date, detail: { revision: result.revision } });
  return { data: result };
});
