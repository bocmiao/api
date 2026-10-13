import { HttpError } from '../../lib/http.js';

const content = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new HttpError(400, `${name}格式不正确`);
  return v.trim();
};

export function buildNotifyMessage(input) {
  const channel = input?.channel;
  const format = input?.format ?? 'text';
  if (!['wecom', 'qq-bot'].includes(channel) || !['text', 'markdown'].includes(format)) throw new HttpError(400, 'channel 或 format 不支持');
  const title = content(input.title, '标题', 100);
  const text = content(input.text, '正文', 1500);
  const rendered = `${title}\n${text}`;
  const payload = channel === 'wecom'
    ? { msgtype: format, [format]: { content: format === 'markdown' ? `**${title}**\n${text}` : rendered } }
    : format === 'markdown' ? { msg_type: 2, markdown: { content: `**${title}**\n${text}` } } : { msg_type: 0, content: rendered };
  return { channel, format, payload };
}

export default {
  name: 'notify-message', category: 'tools', title: '通知消息构建',
  description: '校验并预览企微或 QQ 官方机器人消息 JSON；不需要凭据，也不会发送',
  source: '本站格式校验（不访问外部服务）',
  routes: [{
    method: 'POST', path: '/api/notify/message', summary: '构建并校验消息 JSON，不发送',
    params: [
      { name: 'channel', in: 'body', required: true, desc: 'wecom 或 qq-bot', example: 'wecom' },
      { name: 'format', in: 'body', default: 'text', desc: 'text 或 markdown', example: 'text' },
      { name: 'title', in: 'body', required: true, desc: '标题，最多 100 字', example: '测试通知' },
      { name: 'text', in: 'body', required: true, desc: '正文，最多 1500 字', example: '消息内容' },
    ],
    fields: [
      { name: 'channel', type: 'string', desc: '目标平台' }, { name: 'format', type: 'string', desc: '消息格式' },
      { name: 'payload', type: 'object', desc: '预览用 JSON；不含凭据' },
      { name: 'payload.*', type: 'string|number|object', desc: '平台消息字段' },
      { name: 'payload.*.content', type: 'string', desc: '平台文本内容' },
    ],
    handler({ body }) { return { data: buildNotifyMessage(body) }; },
  }],
};
