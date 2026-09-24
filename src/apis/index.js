// 在这里注册新的 API 模块。每个模块导出 { name, title, routes: [{ method, path, summary, params, handler }] }
import epic from './epic.js';

export const modules = [epic];
