// 按北京时间计算"今天"，每天 0 点重置额度
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = (d = new Date(Date.now())) => dayFmt.format(d);
