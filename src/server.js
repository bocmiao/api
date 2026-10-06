import { createServer } from 'node:http';
import { config } from './config.js';
import { handle } from './app.js';
import { pruneLogs } from './lib/limits.js';
import { pruneLoginLog } from './lib/audit.js';
import { pruneEmailCodes } from './lib/emailcode.js';
import { startScheduler } from './notify/scheduler.js';
import { clearPending, readPending } from './lib/swap.js';
import { warmToday } from './routes/account.js';
import { startPrewarm } from './lib/prewarm.js';
import { startStats, flushStats } from './lib/stats.js';
import { startHealthChecks, pruneHealth } from './lib/health.js';

const prune = () => { pruneLogs(); pruneEmailCodes(); pruneHealth(); pruneLoginLog(); };
prune();
setInterval(prune, 6 * 3600_000).unref();
startScheduler();
warmToday();
startPrewarm();
startStats();
startHealthChecks();
// 退出前把内存里还没写入的统计写进数据库
process.on('exit', flushStats); // 数据库操作是同步的，退出时（含在线更新重启）也能写完
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => process.exit(0));

createServer(handle).listen(config.port, () => {
  console.log(`Miao API 已启动：http://localhost:${config.port}`);
  // 在线更新后，新版本稳定运行 20 秒即视为更新成功，守护进程不再回滚
  if (readPending()) setTimeout(clearPending, 20_000).unref();
});
