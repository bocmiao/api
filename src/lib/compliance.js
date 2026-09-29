// 备案合规模式：网站备案（ICP / 公安）审核期间，一键下线容易被认定为违规或高风险的接口，
// 公开页面也不再展示它们；备案完成后在「系统设置 → 基础」关闭即可恢复，代码和数据都不删除。
export const COMPLIANCE_MODULES = {
  ai: '生成式 AI 服务需先完成生成式人工智能服务备案 / 登记',
  crypto: '虚拟货币相关信息',
  fortune: '运势类内容可能被认定为封建迷信',
  numerology: '吉凶类内容可能被认定为封建迷信',
  answer: '占卜类内容可能被认定为封建迷信',
  shorturl: '公开短链服务容易被用于传播违规链接',
  crawl: '整站抓取可能被认定为爬虫工具',
  'email-check': '邮箱有效性检测可能被用于垃圾邮件',
  'hot-v2ex': '数据源为境内无法访问的网站',
};

export const complianceOn = () => process.env.COMPLIANCE_MODE === '1';
export const complianceBlocks = (name) => complianceOn() && Object.hasOwn(COMPLIANCE_MODULES, name);
