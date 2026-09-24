// 守护进程：启动并看护 server.js。
// - 退出码 75：在线更新完成，立即用新代码重启
// - 其他异常退出：延迟重启；若刚完成更新且新版本在健康确认前崩溃，先回滚到旧版本再重启
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPending, rollbackPending } from './lib/swap.js';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
export const RESTART_CODE = 75;

let child = null;
let stopping = false;
let delay = 1000;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [...process.execArgv, SERVER], {
    stdio: 'inherit',
    env: { ...process.env, MIAO_LAUNCHER: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(code ?? 0);
    if (code === RESTART_CODE) {
      console.log('[launcher] 更新完成，正在重启服务');
      delay = 1000;
      return start();
    }
    const uptime = Date.now() - startedAt;
    console.error(`[launcher] 服务退出（code=${code}, signal=${signal}），运行了 ${Math.round(uptime / 1000)} 秒`);
    if (readPending()) {
      try {
        if (rollbackPending()) console.error('[launcher] 新版本启动失败，已自动回滚到更新前的版本');
      } catch (err) {
        console.error('[launcher] 回滚失败：', err);
      }
    }
    if (uptime > 60_000) delay = 1000;
    setTimeout(start, delay);
    delay = Math.min(delay * 2, 30_000);
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
