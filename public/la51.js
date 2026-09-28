// 51.la 统计初始化：配置由服务端写在 data-config 里（来自「系统设置 → 第三方统计」）
(function () {
  var s = document.currentScript;
  try {
    var c = JSON.parse(s.getAttribute('data-config'));
    if (window.LA && typeof window.LA.init === 'function') window.LA.init(c);
  } catch (e) { /* 统计脚本加载失败不影响网站 */ }
})();
