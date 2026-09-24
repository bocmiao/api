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
    const ehlo = await cmd('EHLO api-hub', [250]);
    if (!implicitTls && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      socket = tls.connect({ socket, servername: host });
      await new Promise((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
      read = reader(socket);
      await cmd('EHLO api-hub', [250]);
    }
    if (user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(user), [334]);
      await cmd(b64(pass || ''), [235]);
    }
    const addr = (s) => s.match(/<([^>]+)>/)?.[1] ?? s;
    await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = b64(text).replace(/.{76}/g, '$&\r\n');
    const msg = [
      `From: ${from}`,
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
