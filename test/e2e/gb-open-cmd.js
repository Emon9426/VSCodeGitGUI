/** 执行 gitboard.open 命令：node gb-open-cmd.js <port> */
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
  await sleep(800);
  await page.keyboard.type('GitBoard: Open Commit Graph', { delay: 25 });
  await sleep(900);
  await page.keyboard.press('Enter');
  await sleep(2500);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('iframes:', list.filter(t => t.type === 'iframe').length);
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
