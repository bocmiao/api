// 最小 SMTP 客户端：支持 465（隐式 TLS）与 587/25（STARTTLS），AUTH LOGIN，纯文本 UTF-8 邮件
import net from 'node:net';
import tls from 'node:tls';

function reader(socket) {
  let buf = '';
  const waiters = [];
  const flush = () => {
    // 多行响应以 "250-" 继续，"250 " 结束
    while (waiters.length) {
      const m = buf.match(/^(?:\d{3}-.*\r\n)*(\d{3}) .*\r\n/);
      if (!m) return;
      buf = buf.slice(m[0].length);
      waiters.shift()({ code: Number(m[1]), text: m[0] });
    }
  };
  socket.on('data', (d) => { buf += d.toString('utf8'); flush(); });
  return () => new Promise((resolve) => { waiters.push(resolve); flush(); });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

// 多数邮箱服务（如腾讯企业邮）要求发信地址与登录账号一致：
// 信封和 From 头的地址一律使用登录账号，SMTP_FROM 只取其中的显示名称
export function senderOf(from, user) {
  const raw = String(from ?? '').trim();
  const addrInFrom = raw.match(/<([^>]+)>/)?.[1]?.trim() ?? (raw.includes('@') ? raw : null);
  const address = (user || addrInFrom || '').trim();
  const name = raw.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '') || (raw.includes('@') ? '' : raw);
  const display = name && !name.includes('@') ? name : '';
  return { envelope: address, header: display ? `${encodeHeader(display)} <${address}>` : address };
}

export async function sendMail({ host, port, user, pass, from, to, subject, text }) {
  const implicitTls = port === 465;
  let socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(15_000, () => socket.destroy(new Error('SMTP 连接超时')));
  const failed = new Promise((_, reject) => socket.once('error', reject));
  let read = reader(socket);

  const expect = async (codes) => {
    const res = await Promise.race([read(), failed]);
    if (!codes.includes(res.code)) throw new Error(`SMTP 错误：${res.text.trim()}`);
    return res;
  };
  const cmd = (line, codes) => { socket.write(line + '\r\n'); return expect(codes); };

  try {
    await expect([220]);
    const ehlo = await cmd('EHLO miao-api', [250]);
    if (!implicitTls && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      socket = tls.connect({ socket, servername: host });
      await new Promise((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
      read = reader(socket);
      await cmd('EHLO miao-api', [250]);
    }
    if (user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(user), [334]);
      await cmd(b64(pass || ''), [235]);
    }
    const { envelope, header } = senderOf(from, user);
    await cmd(`MAIL FROM:<${envelope}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = b64(text).replace(/.{76}/g, '$&\r\n');
    const msg = [
      `From: ${header}`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '.',
    ].join('\r\n');
    await cmd(msg, [250]);
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}
