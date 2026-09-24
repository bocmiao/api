import games from './games/index.js';
import hot from './hot/index.js';
import life from './life/index.js';
import finance from './finance/index.js';
import fun from './fun/index.js';
import tools from './tools/index.js';

export const categories = [
  { id: 'games', title: '游戏', icon: 'gamepad' },
  { id: 'hot', title: '热榜', icon: 'flame' },
  { id: 'life', title: '生活', icon: 'sun' },
  { id: 'finance', title: '金融', icon: 'trend' },
  { id: 'fun', title: '娱乐', icon: 'sparkle' },
  { id: 'tools', title: '工具', icon: 'wrench' },
];

export const modules = [...games, ...hot, ...life, ...finance, ...fun, ...tools];
