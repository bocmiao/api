// B 站 WBI 签名：https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md
import { createHash } from 'node:crypto';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

export function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

// 从 nav 接口 data.wbi_img 的 img_url / sub_url 中取文件名作为 key
export function keysFromNav(nav) {
  const img = nav?.data?.wbi_img;
  const name = (u) => u?.split('/').pop()?.split('.')[0];
  const imgKey = name(img?.img_url);
  const subKey = name(img?.sub_url);
  return imgKey && subKey ? { imgKey, subKey } : null;
}

export function signWbi(params, { imgKey, subKey }, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}
