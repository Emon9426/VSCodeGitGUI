/** 打开 GitBoard 面板（带焦点点击 + 命令面板回退），轮询直到 webview iframe 出现 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入，
// 防 "9227@evil.com" 之类参数被解析为 userinfo+恶意主机（SSRF 面）。
const PORT = (() => {
  const raw = process.argv[2] || '9227';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
  return raw;
})();
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(1500);
  // 先点一下标题栏区域让 workbench 获得焦点
  await page.mouse.click(400, 300);
  await sleep(500);
  await page.keyboard.press('Control+Alt+G');
  let found = false;
  for (let i = 0; i < 10 && !found; i++) {
    await sleep(1500);
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (ts.some(t => t.type === 'iframe')) { found = true; break; }
  }
  if (!found) {
    // 命令面板回退
    await page.keyboard.press('Control+Shift+P');
    await sleep(800);
    await page.keyboard.type('GitBoard', { delay: 40 });
    await sleep(800);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10 && !found; i++) {
      await sleep(1500);
      const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (ts.some(t => t.type === 'iframe')) found = true;
    }
  }
  console.log(found ? 'WEBVIEW-OPEN' : 'WEBVIEW-MISSING');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
