/** 触发 VS Code Reload Window：node gb-reload.js <port> */
const { chromium } = require('playwright-core');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools'));
  await page.bringToFront();
  await page.keyboard.press('Control+Shift+P');
  await sleep(600);
  await page.keyboard.type('Developer: Reload Window', { delay: 30 });
  await sleep(600);
  await page.keyboard.press('Enter');
  console.log('reload sent');
  b.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
