import { createServer } from 'node:http';
import { config } from './config.js';
import { handle } from './app.js';
import { pruneLogs } from './lib/limits.js';
import { startScheduler } from './notify/scheduler.js';

pruneLogs();
setInterval(pruneLogs, 6 * 3600_000).unref();
startScheduler();

createServer(handle).listen(config.port, () => {
  console.log(`Miao API 已启动：http://localhost:${config.port}`);
});
