// 在 <head> 里同步执行：先按用户选过的主题设置页面颜色，避免页面先闪一下另一种颜色
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* 无痕模式等读不到时用系统主题 */ }
