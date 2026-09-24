import { sql } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { topics } from './topics.js';
import { sendToChannel } from './channels.js';

async function deliver(channels, message) {
  const results = await Promise.allSettled(channels.map((c) => sendToChannel(c, message)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[notify] 渠道 ${channels[i].id} (${channels[i].type}) 推送失败:`, r.reason?.message);
  });
  return results;
}

// 检查所有有订阅者的主题，内容变化时推送。首次检查只记录状态，不推送旧内容。
export async function runChecks() {
  const active = sql('SELECT DISTINCT topic FROM subscriptions').all().map((r) => r.topic);
  for (const id of active) {
    const topic = topics[id];
    if (!topic) continue;
    try {
      const result = await topic.check();
      if (!result) continue;
      const prev = sql('SELECT fingerprint FROM topic_state WHERE topic = ?').get(id)?.fingerprint;
      sql(`INSERT INTO topic_state (topic, fingerprint, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(topic) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`).run(id, result.fingerprint);
      if (prev == null || prev === result.fingerprint) continue;

      const channels = sql(`SELECT c.* FROM subscriptions s JOIN channels c ON c.id = s.channel_id
                            JOIN users u ON u.id = c.user_id WHERE s.topic = ? AND u.disabled = 0`).all(id);
      await deliver(channels, { ...result.message, topic: id });
    } catch (err) {
      console.error(`[notify] 主题 ${id} 检查失败:`, err.message);
    }
  }
}

// 控制台里的"立即推送一次"
export async function pushNow(topicId, channel) {
  const topic = topics[topicId];
  if (!topic) throw new HttpError(404, '主题不存在');
  const result = await topic.check();
  if (!result) throw new HttpError(404, '该主题暂无内容');
  await sendToChannel(channel, { ...result.message, topic: topicId });
}

export function startScheduler() {
  const run = () => runChecks().catch((e) => console.error('[notify]', e));
  setTimeout(run, 30_000).unref();
  setInterval(run, config.notifyIntervalMin * 60_000).unref();
}
