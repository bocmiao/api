// 惰性读取 data/ 下的大 JSON（新华词典成语约 7MB、汉字约 3MB）：第一次用到时才读盘并常驻内存，
// 启动时不加载。不是接口模块，fun/index.js 不注册它。
import fs from 'node:fs';

// 直接读，不缓存；配合 lazy() 用，读出来转换后只保留转换结果，免得原始数组和转换结果各占一份内存
export const readDataJSON = (relPath) => JSON.parse(fs.readFileSync(new URL(`./data/${relPath}`, import.meta.url), 'utf8'));

// build() 只在第一次调用时执行，之后返回同一个结果
export function lazy(build) {
  let value;
  let done = false;
  return () => {
    if (!done) { value = build(); done = true; }
    return value;
  };
}
