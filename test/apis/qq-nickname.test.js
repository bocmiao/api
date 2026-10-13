import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadNickname, parsePortrait } from '../../src/apis/tools/qq-nickname.js';
import nicknameModule from '../../src/apis/tools/qq-nickname.js';
import { assertFieldsDocumented } from '../helpers/fields.js';

const portrait = (qq, name) => `portraitCallBack({"${qq}":[0,0,0,0,0,0,${JSON.stringify(name)}]});`;
const reply = (text, init = {}) => new Response(text, { headers: { 'content-type': 'text/plain', ...init.headers }, ...init });

test('QQ 昵称：固定腾讯地址、精确号码、解析真实昵称结构并登记字段', async () => {
  const fetcher = mock.fn(async (url, init) => {
    assert.equal(url, 'https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?get_nick=1&uins=10001');
    assert.equal(init.redirect, 'manual');
    return reply(Buffer.concat([
      Buffer.from('portraitCallBack({"10001":[0,0,0,0,0,0,"'),
      Buffer.from('b2e2cad4eac7b3c6', 'hex'),
      Buffer.from('"]});'),
    ]));
  });
  const data = await loadNickname('10001', fetcher);
  assert.deepEqual(data, { qq: '10001', nickname: '测试昵称' });
  assertFieldsDocumented(nicknameModule.routes[0], data);
  assert.equal(fetcher.mock.callCount(), 1);
});

test('QQ 昵称：错误或无法确认的上游数据不伪造成功', async () => {
  for (const raw of ['', 'portraitCallBack({});', portrait('10002', '别人的昵称'), portrait('10001', ''),
    'portraitCallBack({"10001":[0,0,0,0,0,0,"\ufffd"]});',
    'portraitCallBack({"10001":[0,0,0,0,0,0,"a"]});alert(1)']) {
    assert.throws(() => parsePortrait(raw, '10001'), { status: 502 });
  }
  await assert.rejects(() => loadNickname('abc', mock.fn()), { status: 400 });
  await assert.rejects(() => loadNickname('10001', async () => reply('<html>验证码</html>')), { status: 502 });
  await assert.rejects(() => loadNickname('10001', async () => reply('x'.repeat(17000))), { status: 502 });
  await assert.rejects(() => loadNickname('10001', async () => reply('', { status: 429 })), { status: 503 });
  await assert.rejects(() => loadNickname('10001', async () => reply('', { status: 302, headers: { location: 'https://evil.test/' } })), { status: 502 });
  await assert.rejects(() => loadNickname('10001', async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }), { status: 504 });
  await assert.rejects(() => loadNickname('10001', async () => reply(new Uint8Array([0xff]))), { status: 502 });
});

test('QQ 昵称：尊重 UTF-8 声明与 BOM，拒绝未知、冲突及歧义编码', async () => {
  const utf8 = Buffer.from(portrait('10001', '中文昵称'));
  const declared = await loadNickname('10001', async () => reply(utf8, { headers: { 'content-type': 'text/plain; charset=UTF-8' } }));
  assert.equal(declared.nickname, '中文昵称');
  const bom = await loadNickname('10001', async () => reply(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])));
  assert.equal(bom.nickname, '中文昵称');
  for (const response of [
    reply(utf8),
    reply(utf8, { headers: { 'content-type': 'text/plain; charset=unknown' } }),
    reply(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), { headers: { 'content-type': 'text/plain; charset=gbk' } }),
    reply(Buffer.from([0xff]), { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  ]) await assert.rejects(() => loadNickname('10001', async () => response), { status: 502 });
});
