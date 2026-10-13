const button = document.getElementById('copy-qq');
const input = document.getElementById('qq');
const status = document.getElementById('copy-status');

button?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = 'QQ 号已复制。请在 QQ 内搜索。';
  } catch {
    input.focus();
    input.select();
    status.textContent = '浏览器未允许自动复制；号码已选中，请手动复制后在 QQ 内搜索。';
  }
});
