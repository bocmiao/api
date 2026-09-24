import { createServer } from 'node:http';
import { config } from './config.js';
import { handle } from './app.js';
import { pruneLogs } from './lib/limits.js';
import { startScheduler } from './notify/scheduler.js';
import { clearPending, readPending } from './lib/swap.js';

pruneLogs();
setInterval(pruneLogs, 6 * 3600_000).unref();
startScheduler();

createServer(handle).listen(config.port, () => {
  console.log(`Miao API 已启动：http://localhost:${config.port}`);
  // 在线更新后，新版本稳定运行 20 秒即视为更新成功，守护进程不再回滚
  if (readPending()) setTimeout(clearPending, 20_000).unref();
});
