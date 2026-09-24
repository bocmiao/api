import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录（src 的上一级）与数据目录；数据目录与 db.js 保持一致
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const dataDir = () => process.env.DATA_DIR || join(process.cwd(), 'data');

// 在线更新时保留不动的顶层条目
export const KEEP = new Set(['data', '.env', 'node_modules', '.git', '.update-staging', '.update-backup', '.update-failed']);
