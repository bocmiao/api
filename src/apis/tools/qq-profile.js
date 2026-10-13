import { HttpError, param } from '../../lib/http.js';
import { QQ_RE } from './qq-avatar.js';

const readQQ = (query) => param(query, 'qq', { required: true, pattern: QQ_RE });

export function qqProfileUrl(qq) {
  if (!QQ_RE.test(String(qq))) throw new HttpError(400, 'qq 须为 5~12 位数字');
  return `mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=${qq}`;
}

export function profilePage(qq) {
  const url = qqProfileUrl(qq).replaceAll('&', '&amp;');
  // qq 经过纯数字白名单校验，不能注入 HTML 或外部 URL。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打开 QQ 资料卡</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:10vh auto;padding:0 1.25rem;color:#17212b}a,button{display:inline-block;margin:.5rem .5rem .5rem 0;padding:.65rem 1rem;border-radius:.5rem;border:1px solid #1768c0;background:#1768c0;color:white;text-decoration:none;font:inherit;cursor:pointer}button{background:white;color:#1768c0}input{font:inherit;padding:.5rem;width:11rem}p{color:#4c5968}</style></head><body>
<h1>打开 QQ 资料卡</h1><p>QQ 号：<input id="qq" value="${qq}" readonly aria-label="QQ 号"></p>
<a id="open-qq" href="${url}">点击在 QQ 中打开</a><button id="copy-qq" type="button">复制 QQ 号</button>
<p id="copy-status" role="status" aria-live="polite">若未安装 QQ 或浏览器拦截，请复制号码后在 QQ 内手动搜索。此链接不查询昵称，也不能保证唤起成功。</p>
<script src="/qq-profile.js" defer></script></body></html>`;
}

export default {
  name: 'qq-profile',
  category: 'tools',
  title: 'QQ 资料卡链接',
  description: '生成 QQ 客户端资料卡 Scheme 链接；需要用户点击，实际唤起取决于设备和 QQ 客户端',
  source: '公开使用的 mqqapi:// Scheme（非腾讯公开稳定规范，不查询用户资料）',
  unofficial: true,
  routes: [
    {
      method: 'GET', path: '/api/qq/profile', summary: '返回 QQ 资料卡链接及点击打开页',
      params: [{ name: 'qq', required: true, desc: 'QQ 号，5~12 位数字', example: '10001' }],
      fields: [
        { name: 'qq', type: 'string', desc: '输入的 QQ 号' },
        { name: 'url', type: 'string', desc: 'QQ 客户端资料卡 Scheme 链接，须由用户点击；不保证能唤起' },
        { name: 'openPage', type: 'string', desc: '本站点击打开页路径，未唤起时可复制 QQ 号' },
      ],
      handler({ query }) {
        const qq = readQQ(query);
        return { data: { qq, url: qqProfileUrl(qq), openPage: `/api/qq/profile/open?qq=${qq}` } };
      },
    },
    {
      method: 'GET', path: '/api/qq/profile/open', raw: true,
      summary: '展示用户点击打开页，含复制 QQ 号按钮',
      params: [{ name: 'qq', required: true, desc: 'QQ 号，5~12 位数字', example: '10001' }],
      returns: 'HTML 页面；用户点击 mqqapi:// 链接尝试唤起 QQ，浏览器拦截或未安装时可复制 QQ 号。不会自动跳转。',
      handler({ query }) {
        return { status: 200, headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        }, body: profilePage(readQQ(query)) };
      },
    },
  ],
};
