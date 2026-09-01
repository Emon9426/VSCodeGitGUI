/** DOM 诊断：node gb-dom-diag.js <port> */
const { chromium } = require('playwright-core');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools'));
  await page.bringToFront();
  const info = await page.evaluate(() => {
    const ab = document.getElementById('workbench.parts.activitybar');
    const items = ab ? [...ab.querySelectorAll('li.action-item')].map(el => (el.querySelector('a')?.getAttribute('aria-label') || '').trim()) : [];
    const sideTitle = (document.querySelector('.sidebar .title-label') || {}).textContent || null;
    const tabs = [...document.querySelectorAll('.tab .label-name')].slice(0, 15).map(t => (t.textContent || '').trim());
    const webviewEls = document.querySelectorAll('webview').length;
    const treeItems = [...document.querySelectorAll('.sidebar .monaco-list-row')].slice(0, 10).map(r => (r.textContent || '').trim().slice(0, 40));
    return { items, sideTitle, tabs, webviewEls, treeItems };
  });
  console.log(JSON.stringify(info, null, 1));
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
