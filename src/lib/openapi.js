// 从运行时接口目录生成对外契约：OpenAPI 3.1 与 llms.txt。
// 参数、字段说明都来自同一份 registry，后台改了文案或新增接口后自动同步，不需要另写文档。
import { getModules } from '../registry.js';
import { categories } from '../apis/index.js';
import { isModuleEnabled } from './modules.js';
import { RUNNING_VERSION } from './updater.js';

const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const oaPath = (path) => path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');

function paramSchema(p) {
  const isInt = p.int || p.type === 'int';
  const schema = { type: isInt ? 'integer' : 'string' };
  if (p.oneOf?.length) schema.enum = isInt ? p.oneOf.map(Number) : p.oneOf;
  if (p.min != null && isInt) schema.minimum = p.min;
  if (p.max != null && isInt) schema.maximum = p.max;
  if (p.max != null && !isInt) schema.maxLength = p.max;
  if (p.default !== undefined) schema.default = p.default;
  if (p.pattern) schema.pattern = String(p.pattern?.source ?? p.pattern);
  return schema;
}

export function openapi(origin) {
  const paths = {};
  const operations = [];
  for (const mod of getModules()) {
    if (!isModuleEnabled(mod.name)) continue;
    const info = mod.sourceInfo ?? null;
    for (const route of mod.routes) {
      const pathNames = [...route.path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
      const query = (route.params ?? []).filter((p) => p.in !== 'body' && !pathNames.includes(p.name));
      const bodyParams = (route.params ?? []).filter((p) => p.in === 'body');
      const key = oaPath(route.path);
      const operationId = `${slug(mod.name)}-${route.method.toLowerCase()}-${Buffer.from(route.path).toString('base64url')}`;
      const operation = {
        tags: [mod.category],
        summary: route.summary ?? route.path,
        description: mod.description ?? '',
        operationId,
        parameters: [...pathNames.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })), ...query.map((p) => ({
          name: p.name,
          in: 'query',
          required: Boolean(p.required),
          description: p.desc ?? '',
          schema: paramSchema(p),
          ...(p.example != null && p.example !== '' ? { example: p.int || p.type === 'int' ? Number(p.example) : p.example } : {}),
        }))],
        responses: {
          200: {
            description: '统一 JSON 返回',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
          },
        },
        'x-miao': {
          module: mod.name,
          category: mod.category,
          origin: mod.origin ?? 'core',
          source: info,
          fields: route.fields ?? [],
          returns: route.returns ?? null,
          raw: Boolean(route.raw),
        },
      };
      if (bodyParams.length) {
        const properties = Object.fromEntries(bodyParams.map((p) => [p.name, { ...paramSchema(p), description: p.desc ?? '' }]));
        operation.requestBody = {
          required: bodyParams.some((p) => p.required),
          content: {
            'application/json': {
              schema: { type: 'object', properties, required: bodyParams.filter((p) => p.required).map((p) => p.name) },
            },
          },
        };
      }
      paths[key] ??= {};
      paths[key][route.method.toLowerCase()] = operation;
      operations.push(operationId);
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Miao API',
      version: RUNNING_VERSION,
      description: '聚合 API 平台：统一 JSON 返回格式、字段中文说明、支持跨域与 API Key。本文件由接口注册表自动生成。',
      license: { name: 'GPL-3.0-only', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
    },
    servers: [{ url: origin }],
    tags: categories.map((c) => ({ name: c.id, description: c.title })),
    paths,
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          properties: {
            code: { type: 'integer', description: '200 表示成功' },
            message: { type: 'string', description: '提示信息' },
            cached: { type: 'boolean', description: '是否来自缓存' },
            stale: { type: 'boolean', description: '上游失败时返回的旧数据' },
            updatedAt: { type: 'string', description: '数据更新时间' },
            requestId: { type: 'string', description: '请求 ID，反馈问题时附上' },
            data: { description: '业务数据，字段说明见 x-miao.fields' },
          },
        },
      },
    },
    'x-miao-operations': operations,
  };
}

export function llmsTxt(origin) {
  const lines = [
    '# Miao API',
    '',
    `> ${getModules().filter((m) => isModuleEnabled(m.name)).length} 个常用接口的聚合平台，统一返回 { code, message, cached, stale, updatedAt, data }。`,
    `> 文档：${origin}/docs　接口目录：${origin}/api　OpenAPI：${origin}/openapi.json`,
    '',
  ];
  for (const cat of categories) {
    const mods = getModules().filter((m) => m.category === cat.id && isModuleEnabled(m.name));
    if (!mods.length) continue;
    lines.push(`## ${cat.title}`, '');
    for (const mod of mods) {
      for (const route of mod.routes) {
        const params = (route.params ?? []).map((p) => `${p.name}${p.required ? '*' : ''}（${p.desc ?? ''}）`).join('、');
        lines.push(`- ${route.method} ${route.path} — ${route.summary ?? mod.title}${params ? `；参数：${params}` : ''}`);
        const fields = (route.fields ?? []).slice(0, 12).map((f) => `${f.name}(${f.type})`).join('、');
        if (fields) lines.push(`  返回字段：${fields}${(route.fields ?? []).length > 12 ? ' 等' : ''}`);
      }
    }
    lines.push('');
  }
  lines.push(`完整字段说明与参数示例见 ${origin}/docs/<接口名>。`, '');
  return lines.join('\n');
}
