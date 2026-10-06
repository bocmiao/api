import { HttpError, param } from '../../lib/http.js';

// QQ 头像：腾讯官方公开的头像地址 q1.qlogo.cn，按 QQ 号直接拼出，不请求上游、不查询昵称等其他资料。
export const QQ_RE = /^[1-9]\d{4,11}$/;
export const AVATAR_SIZES = [40, 100, 140, 640];

export function qqAvatarUrl(qq, size = 640) {
  if (!QQ_RE.test(String(qq))) throw new HttpError(400, 'qq 须为 5~12 位数字');
  if (!AVATAR_SIZES.includes(Number(size))) throw new HttpError(400, `size 只能是 ${AVATAR_SIZES.join(' / ')}`);
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=${size}`;
}

const readQQ = (query) => param(query, 'qq', { required: true, pattern: QQ_RE });

export default {
  name: 'qq-avatar',
  category: 'tools',
  title: 'QQ 头像',
  description: '按 QQ 号获取 QQ 头像地址，支持 40 / 100 / 140 / 640 像素，可直接用作 <img> 地址（博客评论头像等）',
  source: 'QQ 官方头像地址 q1.qlogo.cn（本地拼接，不查询昵称等资料）',
  routes: [
    {
      method: 'GET',
      path: '/api/qq/avatar',
      raw: true,
      summary: '302 跳转到 QQ 头像图片，可直接用作 <img> 地址',
      params: [
        { name: 'qq', required: true, desc: 'QQ 号，5~12 位数字', example: '10000' },
        { name: 'size', default: 640, desc: `图片尺寸：${AVATAR_SIZES.join(' / ')}`, example: '140' },
      ],
      returns: '302 跳转到 QQ 头像图片（PNG / JPG）。没有设置头像的账号返回 QQ 默认头像。响应头 Cache-Control: public, max-age=86400',
      handler({ query }) {
        const location = qqAvatarUrl(readQQ(query), param(query, 'size', { default: '640', oneOf: AVATAR_SIZES.map(String) }));
        return { status: 302, headers: { location, 'cache-control': 'public, max-age=86400' }, body: '' };
      },
    },
    {
      method: 'GET',
      path: '/api/qq/avatar/urls',
      summary: '返回各个尺寸的 QQ 头像地址',
      params: [{ name: 'qq', required: true, desc: 'QQ 号，5~12 位数字', example: '10000' }],
      fields: [
        { name: 'qq', type: 'string', desc: 'QQ 号' },
        { name: 'avatar', type: 'string', desc: '640 像素头像地址（最清晰）' },
        { name: 'sizes', type: 'object', desc: '各尺寸头像地址，键为像素：40 / 100 / 140 / 640' },
      ],
      handler({ query }) {
        const qq = readQQ(query);
        return {
          data: {
            qq,
            avatar: qqAvatarUrl(qq, 640),
            sizes: Object.fromEntries(AVATAR_SIZES.map((s) => [s, qqAvatarUrl(qq, s)])),
          },
        };
      },
    },
  ],
};
