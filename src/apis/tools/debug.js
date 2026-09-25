import { randomInt, randomUUID, randomBytes } from 'node:crypto';
import { param } from '../../lib/http.js';

// ---------------- 请求回显 ----------------

// 凭据类请求头一律不回显（包括本站的 API Key、登录 Cookie），名称里带 token / secret / session 等字样的也去掉
const SENSITIVE = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key)$|token|secret|passw|session|api[-_]?key|auth|credential|signature/i;
const SENSITIVE_QUERY = /^key$|token|secret|passw|session|api[-_]?key|auth|credential|signature/i;

export function echoRequest({ req, ip, query, body }, method, now = Date.now()) {
  const headers = {};
  const removedHeaders = [];
  for (const [k, v] of Object.entries(req?.headers ?? {})) {
    if (SENSITIVE.test(k)) removedHeaders.push(k);
    else headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const q = {};
  const removedQuery = [];
  for (const [k, v] of query ?? []) {
    if (SENSITIVE_QUERY.test(k)) {
      if (!removedQuery.includes(k)) removedQuery.push(k);
      continue;
    }
    if (!(k in q)) q[k] = v;
    else q[k] = [].concat(q[k], v);
  }
  let path = '/api/tools/echo';
  try {
    if (req?.url) path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    // 保持默认
  }
  return {
    method,
    path,
    query: q,
    body: method === 'POST' && body !== undefined ? JSON.stringify(body) : null,
    headers,
    removedHeaders,
    removedQuery,
    ip: ip ?? null,
    httpVersion: req?.httpVersion ?? null,
    time: new Date(now).toISOString(),
  };
}

// ---------------- 随机测试数据 ----------------

const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严武戴莫孔向汤';
const GIVEN_M = '伟强磊军洋勇杰涛明超刚辉力俊峰波宁龙国胜学祥飞彬鹏泽晨浩亮政宏博诚翔旭哲宇轩睿昊然';
const GIVEN_F = '芳娜秀英敏静丽艳娟霞婷雪琳慧巧美淑惠珠玉萍红玲芬燕彩春兰凤洁梅颖露瑶怡欣悦菲晴妍';
const PLACES = [
  ['北京市', '北京市', ['朝阳区', '海淀区', '东城区', '西城区', '丰台区']], ['上海市', '上海市', ['浦东新区', '徐汇区', '静安区', '黄浦区']],
  ['广东省', '广州市', ['天河区', '越秀区', '海珠区']], ['广东省', '深圳市', ['南山区', '福田区', '宝安区']],
  ['浙江省', '杭州市', ['西湖区', '上城区', '滨江区']], ['江苏省', '南京市', ['玄武区', '鼓楼区', '建邺区']],
  ['四川省', '成都市', ['武侯区', '锦江区', '青羊区']], ['湖北省', '武汉市', ['武昌区', '江汉区', '洪山区']],
  ['陕西省', '西安市', ['雁塔区', '碑林区', '未央区']], ['山东省', '青岛市', ['市南区', '崂山区', '黄岛区']],
];
const ROADS = ['示例路', '测试街', '样例大道', '演示路', '虚拟巷'];
const COMPANY_WORDS = ['星辰', '云帆', '青禾', '远山', '启明', '蓝湾', '拾光', '松果', '鲸落', '极光'];
const COMPANY_TRADES = ['科技', '网络', '文化传媒', '信息技术', '贸易', '设计'];
const TEST_NETS = ['192.0.2', '198.51.100', '203.0.113'];

const pick = (arr) => arr[randomInt(arr.length)];
const pickChar = (s) => [...s][randomInt([...s].length)];
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join('');
const pad = (n) => String(n).padStart(2, '0');

export const MOCK = {
  name: () => pickChar(SURNAMES) + Array.from({ length: randomInt(1, 3) }, () => pickChar(randomInt(2) ? GIVEN_M : GIVEN_F)).join(''),
  // 100 开头的 11 位号码不是任何运营商的手机号段，不会打给真人
  phone: () => `100${digits(8)}`,
  // example.com / .org / .net 是 RFC 2606 保留的示例域名，邮件发不出去
  email: () => `${randomBytes(4).toString('hex')}${randomInt(100)}@${pick(['example.com', 'example.org', 'example.net'])}`,
  address: () => {
    const [prov, city, districts] = pick(PLACES);
    return `${prov === city ? '' : prov}${city}${pick(districts)}${pick(ROADS)}${randomInt(1, 999)}号${randomInt(1, 30)}栋${randomInt(1, 30)}${pad(randomInt(1, 20))}室`;
  },
  company: () => `${pick(COMPANY_WORDS)}${pick(COMPANY_TRADES)}示例有限公司`,
  // RFC 5737 文档专用网段，不会指向真实主机
  ip: () => `${pick(TEST_NETS)}.${randomInt(1, 255)}`,
  // RFC 3849 文档专用前缀 2001:db8::/32
  ipv6: () => `2001:db8:${Array.from({ length: 6 }, () => randomInt(65536).toString(16)).join(':')}`,
  // 首字节 02：本地管理的单播地址，不属于任何厂商
  mac: () => `02:${Array.from({ length: 5 }, () => randomInt(256).toString(16).padStart(2, '0')).join(':')}`,
  uuid: () => randomUUID(),
  date: () => {
    const d = new Date(Date.UTC(1970, 0, 1) + randomInt(0, 60 * 365) * 86400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  },
  color: () => `#${randomBytes(3).toString('hex')}`,
  user: () => {
    const gender = randomInt(2) ? '男' : '女';
    return {
      name: pickChar(SURNAMES) + Array.from({ length: randomInt(1, 3) }, () => pickChar(gender === '男' ? GIVEN_M : GIVEN_F)).join(''),
      gender,
      age: randomInt(18, 66),
      phone: MOCK.phone(),
      email: MOCK.email(),
      address: MOCK.address(),
      company: MOCK.company(),
    };
  },
};

export default {
  name: 'debug-tools',
  category: 'tools',
  title: '请求回显与测试数据',
  description: '回显 HTTP 请求（方法、头、参数、IP），生成明显虚构的测试数据',
  source: '本地计算',
  routes: [
    ...['GET', 'POST'].map((method) => ({
      method,
      path: '/api/tools/echo',
      summary: '请求回显：返回服务器收到的方法、路径、查询参数、请求头、请求体和客户端 IP（Cookie、Authorization、API Key 等凭据会被去掉）',
      params: [
        { name: 'message', required: false, desc: '示例参数；实际可以附带任意参数，都会原样回显（名称像凭据的参数除外）', example: 'hello' },
      ],
      fields: [
        { name: 'method', type: 'string', desc: '请求方法：GET 或 POST' },
        { name: 'path', type: 'string', desc: '请求路径（不含查询参数）' },
        { name: 'query', type: 'object', desc: '网址中的查询参数，键名不固定' },
        { name: 'query.*', type: 'string|array', desc: '一个查询参数的值；同名参数出现多次时为字符串数组' },
        { name: 'query.*[]', type: 'string', desc: '同名参数的其中一个值' },
        { name: 'body', type: 'string|null', desc: 'POST 时为请求体 JSON 解析后再序列化的字符串（紧凑格式）；GET 或没有请求体时为 null' },
        { name: 'headers', type: 'object', desc: '服务器收到的请求头（名称为小写），键名不固定；部署在反向代理后面时会多出 x-forwarded-for 等代理添加的头' },
        { name: 'headers.*', type: 'string', desc: '一个请求头的值；同名头出现多次时用 “, ” 连接' },
        { name: 'removedHeaders', type: 'array', desc: '出于安全考虑没有回显的请求头名称（如 cookie、authorization、x-api-key，以及名称含 token、secret、session、auth 等字样的头），可能为空数组' },
        { name: 'removedHeaders[]', type: 'string', desc: '被去掉的请求头名称（小写）' },
        { name: 'removedQuery', type: 'array', desc: '没有回显的查询参数名称（本站的 API Key 参数 key，以及名称含 token、secret、password 等字样的参数），可能为空数组' },
        { name: 'removedQuery[]', type: 'string', desc: '被去掉的查询参数名称' },
        { name: 'ip', type: 'string|null', desc: '服务器识别到的客户端 IP（开启 TRUST_PROXY 时取 X-Forwarded-For 的第一个地址）' },
        { name: 'httpVersion', type: 'string|null', desc: 'HTTP 协议版本，如 1.1；取不到时为 null' },
        { name: 'time', type: 'string', desc: '服务器处理请求的时间，ISO 8601 UTC' },
      ],
      async handler(ctx) {
        return { data: echoRequest(ctx, method) };
      },
    })),
    {
      method: 'GET',
      path: '/api/tools/mock',
      summary: '生成随机测试数据：姓名、手机号、邮箱、地址、公司、IP、MAC、UUID 等，全部明显虚构（不生成身份证号）',
      params: [
        { name: 'type', default: 'user', desc: 'user 完整用户（对象）；name 姓名；phone 手机号（100 开头，非真实号段）；email 邮箱（example.com 等保留域名）；address 地址（示例路 / 测试街）；company 公司；ip IPv4（RFC 5737 文档网段）；ipv6 IPv6（2001:db8::/32）；mac MAC 地址（本地管理地址）；uuid；date 日期；color 颜色', example: 'name' },
        { name: 'count', default: '5', desc: '数量（1~50）', example: '3' },
      ],
      fields: [
        { name: 'type', type: 'string', desc: '数据类型，与请求参数 type 相同' },
        { name: 'items', type: 'array', desc: '生成结果，长度等于 count；type=user 时每项是对象，其他类型每项是字符串' },
        { name: 'items[]', type: 'string|object', desc: '一条随机数据' },
        { name: 'items[].name', type: 'string', desc: '姓名（随机姓氏 + 1~2 个与性别相符的常见字）' },
        { name: 'items[].gender', type: 'string', desc: '性别：男 / 女' },
        { name: 'items[].age', type: 'number', desc: '年龄（18~65）' },
        { name: 'items[].phone', type: 'string', desc: '手机号：100 开头的 11 位数字，不是任何运营商的号段' },
        { name: 'items[].email', type: 'string', desc: '邮箱，域名为 RFC 2606 保留的 example.com / example.org / example.net' },
        { name: 'items[].address', type: 'string', desc: '地址：真实的省市区 + 虚构的“示例路 / 测试街”等路名和门牌' },
        { name: 'items[].company', type: 'string', desc: '公司名，统一带“示例有限公司”字样' },
      ],
      async handler({ query }) {
        const type = param(query, 'type', { default: 'user', oneOf: Object.keys(MOCK) });
        const count = param(query, 'count', { default: 5, int: true, min: 1, max: 50 });
        return { data: { type, items: Array.from({ length: count }, MOCK[type]) } };
      },
    },
  ],
};
