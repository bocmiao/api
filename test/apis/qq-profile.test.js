import { test } from 'node:test';
import assert from 'node:assert/strict';
import qqProfile, { qqProfileUrl, profilePage } from '../../src/apis/tools/qq-profile.js';
import { assertFieldsDocumented } from '../helpers/fields.js';

test('QQ 资料卡仅拼接白名单号码，JSON 字段完整', () => {
  const route = qqProfile.routes[0];
  const data = route.handler({ query: new URLSearchParams('qq=10001') }).data;
  assert.deepEqual(data, {
    qq: '10001',
    url: 'mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=10001',
    openPage: '/api/qq/profile/open?qq=10001',
  });
  assertFieldsDocumented(route, data);
  for (const qq of ['0', '012345', '1234', '1234567890123', '10001%26x', '10001\" onclick=alert(1)', '']) {
    assert.throws(() => qqProfileUrl(qq), { status: 400 });
  }
});

test('QQ 资料卡打开页仅提供点击链接和复制操作，不自动唤起', () => {
  const page = profilePage('10001');
  assert.match(page, /href="mqqapi:\/\/card\/show_pslcard\?src_type=internal&amp;source=sharecard&amp;version=1&amp;uin=10001"/);
  assert.match(page, /id="copy-qq"/);
  assert.match(page, /src="\/qq-profile.js"/);
  assert.doesNotMatch(page, /onload=|location\s*=|<meta[^>]*refresh/i);
  assert.throws(() => profilePage('1"><script>alert(1)</script>'), { status: 400 });
});
