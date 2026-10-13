import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateChannel, sendToChannel, maskConfig } from '../src/notify/channels.js';
import { sealChannel, openChannel } from '../src/notify/secrets.js';
import { buildNotifyMessage } from '../src/apis/tools/notify-message.js';
import notifyMessage from '../src/apis/tools/notify-message.js';
import { assertFieldsDocumented } from './helpers/fields.js';

const oldKey = process.env.NOTIFY_ENCRYPTION_KEY;
process.env.NOTIFY_ENCRYPTION_KEY = 'a1'.repeat(32);
const msg = { title: '通知', text: '内容', topic: 'test' };

test('消息 JSON 构建只校验预览，不接收凭据或目标', () => {
  assert.deepEqual(buildNotifyMessage({ channel: 'qq-bot', title: '你好', text: '正文' }).payload, { msg_type: 0, content: '你好\n正文' });
  assert.deepEqual(buildNotifyMessage({ channel: 'wecom', format: 'markdown', title: '你好', text: '正文' }).payload,
    { msgtype: 'markdown', markdown: { content: '**你好**\n正文' } });
  assertFieldsDocumented(notifyMessage.routes[0], buildNotifyMessage({ channel: 'qq-bot', format: 'markdown', title: '你好', text: '正文' }));
  assert.throws(() => buildNotifyMessage({ channel: 'qq-bot', title: '', text: 'x' }), { status: 400 });
  assert.throws(() => buildNotifyMessage({ channel: 'other', title: 'x', text: 'x' }), { status: 400 });
});

test('企微固定官方目标、加密保存、脱敏和 text 格式', async () => {
  const cfg = await validateChannel('wecom', { channelId: 'team-a', webhook: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${'A'.repeat(32)}`, format: 'text' });
  const sealed = sealChannel('wecom', cfg);
  assert.ok(!JSON.stringify(sealed).includes('AAAA'));
  assert.deepEqual(openChannel('wecom', sealed), cfg);
  assert.deepEqual(maskConfig('wecom', sealed), { credentials: '已加密保存' });
  await assert.rejects(validateChannel('wecom', { channelId: 'x', webhook: 'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=abc' }), { status: 400 });
  await assert.rejects(validateChannel('wecom', { channelId: 'x', webhook: `https://qyapi.weixin.qq.com/other?key=${'A'.repeat(32)}` }), { status: 400 });
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return Response.json({ errcode: 0 }); });
  try {
    const channel = { id: 9101, type: 'wecom', config: JSON.stringify(sealed) };
    await sendToChannel(channel, msg);
    await sendToChannel(channel, msg);
    assert.equal(sent.length, 1, '同一消息短时间内不重复发送');
    assert.equal(sent[0][1].msgtype, 'text');
    assert.match(sent[0][0], /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=/);
  } finally { mock.restoreAll(); }
});

test('QQ 官方机器人仅向绑定 OpenID 发送，令牌不进日志或持久明文', async () => {
  const cfg = await validateChannel('qq-bot', { appId: '123456789', clientSecret: 's'.repeat(32), targetType: 'group', targetOpenid: 'A'.repeat(32) });
  const sealed = sealChannel('qq-bot', cfg);
  assert.ok(!JSON.stringify(sealed).includes('ssss'));
  assert.deepEqual(openChannel('qq-bot', sealed), cfg);
  await assert.rejects(validateChannel('qq-bot', { ...cfg, targetOpenid: '123456789' }), { status: 400 });
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, opts) => {
    sent.push({ url, opts });
    return String(url).endsWith('/getAppAccessToken') ? Response.json({ access_token: 'fake-token', expires_in: '7200' }) : Response.json({ id: 'message-id' });
  });
  try {
    await sendToChannel({ id: 9102, type: 'qq-bot', config: JSON.stringify(sealed) }, msg);
    assert.equal(sent[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
    assert.equal(sent[1].url, `https://api.bot.qq.com/v2/groups/${'A'.repeat(32)}/messages`);
    assert.equal(sent[1].opts.headers.authorization, 'QQBot fake-token');
    assert.equal(JSON.parse(sent[1].opts.body).msg_type, 0);
  } finally { mock.restoreAll(); }
});

test('未配置加密密钥时不能新增凭据', () => {
  delete process.env.NOTIFY_ENCRYPTION_KEY;
  try { assert.throws(() => sealChannel('qq-bot', { secret: 'x' }), { status: 503 }); }
  finally { if (oldKey == null) delete process.env.NOTIFY_ENCRYPTION_KEY; else process.env.NOTIFY_ENCRYPTION_KEY = oldKey; }
});

test('同一渠道并发发送同一消息仅发一次', async () => {
  const { guardedDelivery } = await import('../src/notify/delivery-guard.js');
  let count = 0;
  const send = async () => { count++; await new Promise((resolve) => setTimeout(resolve, 5)); };
  const channel = { id: 9133, type: 'wecom' };
  const [first, second] = await Promise.all([guardedDelivery(channel, msg, send), guardedDelivery(channel, msg, send)]);
  assert.equal(count, 1);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
});

test('新渠道每分钟本地频率上限', async () => {
  const { guardedDelivery } = await import('../src/notify/delivery-guard.js');
  const channel = { id: 9134, type: 'qq-bot' };
  for (let n = 0; n < 10; n++) await guardedDelivery(channel, { text: `message ${n}` }, async () => {});
  await assert.rejects(() => guardedDelivery(channel, { text: 'message 11' }, async () => {}), { status: 429 });
});
