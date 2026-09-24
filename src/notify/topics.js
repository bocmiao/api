import { invoke } from '../registry.js';
import { today } from '../lib/limits.js';

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const shanghaiHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

// 每个主题：check() 返回 { fingerprint, message } 或 null（暂无内容）。
// fingerprint 变化时向订阅者推送 message。
export const topics = {
  'epic-free': {
    title: 'Epic 周免上新',
    desc: 'Epic 每周免费游戏更新时推送',
    async check() {
      const { current, upcoming } = await invoke('/api/epic/free');
      if (!current.length) return null;
      const lines = current.map((g) => `- **${g.title}**（原价 ${g.originalPrice ?? '—'}，免费至 ${fmtTime(g.endDate)}）\n  ${g.url}`);
      if (upcoming.length) lines.push('', '下周预告：' + upcoming.map((g) => g.title).join('、'));
      return {
        fingerprint: current.map((g) => g.id).sort().join(','),
        message: { title: `Epic 本周免费：${current.map((g) => g.title).join('、')}`, text: lines.join('\n'), url: 'https://store.epicgames.com/zh-CN/free-games' },
      };
    },
  },
  'games-free': {
    title: '全平台游戏限免',
    desc: 'Epic / Steam / GOG 出现新的免费游戏时推送',
    async check() {
      const { items } = await invoke('/api/games/free');
      if (!items.length) return null;
      const lines = items.map((g) => `- [${g.platform}] **${g.title}**${g.endDate ? `（截止 ${fmtTime(g.endDate)}）` : ''}\n  ${g.url}`);
      return {
        fingerprint: items.map((g) => g.id).sort().join(','),
        message: { title: `游戏限免：${items.slice(0, 3).map((g) => g.title).join('、')}${items.length > 3 ? ` 等 ${items.length} 款` : ''}`, text: lines.join('\n') },
      };
    },
  },
  'psplus-monthly': {
    title: 'PS Plus 每月会免',
    desc: 'PlayStation 公布新一期会免游戏时推送',
    async check() {
      const p = await invoke('/api/psplus/monthly');
      if (!p?.games?.length) return null;
      return {
        fingerprint: p.url ?? p.title,
        message: { title: `PS Plus ${p.month ?? ''} 会免公布`, text: p.games.map((g) => `- ${g}`).join('\n'), url: p.url },
      };
    },
  },
  'bing-daily': {
    title: 'Bing 每日壁纸',
    desc: '每天推送必应首页壁纸',
    async check() {
      const [img] = await invoke('/api/bing');
      if (!img) return null;
      return {
        fingerprint: img.date,
        message: { title: `今日壁纸：${img.title ?? img.description ?? ''}`, text: `${img.copyright ?? ''}\n\n![](${img.url})`, url: img.urlUHD ?? img.url },
      };
    },
  },
  'english-daily': {
    title: '每日一句英语',
    desc: '每天推送金山词霸每日一句',
    async check() {
      const d = await invoke('/api/english/daily');
      if (!d?.content) return null;
      return {
        fingerprint: d.date ?? d.content,
        message: { title: '每日一句', text: `${d.content}\n\n${d.translation ?? ''}`, url: d.url },
      };
    },
  },
  'news-60s': {
    title: '60 秒读懂世界',
    desc: '每天推送早间新闻简报',
    async check() {
      const d = await invoke('/api/news/60s');
      if (!d?.news?.length) return null;
      const text = d.news.map((n, i) => `${i + 1}. ${n}`).join('\n') + (d.tip ? `\n\n【微语】${d.tip}` : '');
      return { fingerprint: d.date ?? d.news[0], message: { title: `60 秒读懂世界 ${d.date ?? ''}`.trim(), text, url: d.link } };
    },
  },
  'holiday-remind': {
    title: '放假 / 调休提醒',
    desc: '明天放假或调休上班时，前一天 18 点后提醒',
    async check() {
      if (shanghaiHour() < 18) return null;
      const tomorrow = today(new Date(Date.now() + 86400_000));
      const [t, d] = await Promise.all([invoke('/api/holiday', { date: today() }), invoke('/api/holiday', { date: tomorrow })]);
      let title;
      if (d.type === 'holiday' && t.isWorkday) title = `明天（${d.weekday}）开始放假：${d.name}`;
      else if (d.type === 'workday') title = `明天（${d.weekday}）${d.note}，别忘了定闹钟`;
      else return null;
      return { fingerprint: tomorrow, message: { title, text: `${d.date} ${d.weekday}：${d.note}` } };
    },
  },
};

export function topicCatalog() {
  return Object.entries(topics).map(([id, t]) => ({ id, title: t.title, desc: t.desc }));
}

export { fmtTime, shanghaiHour, today };
