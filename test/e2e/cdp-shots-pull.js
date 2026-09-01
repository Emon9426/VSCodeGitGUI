/** README 截图脚本 ③拉取摘要：点 Fetch → 摘要弹窗截图 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const PORT = (() => {
  const raw = process.argv[2] || '9232';
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
const OUT = 'res/screenshots';

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(800);
  let gb = null;
  for (let i = 0; i < 15 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(1000);
  }
  if (!gb) { console.log('FAIL: no webview'); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // 确保在提交图视图
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /提交图|Graph/i.test(b.textContent) && !/纯/.test(b.textContent))?.click()`);
  await sleep(1500);

  // 点 Fetch（⟳ 按钮，title/aria 含 Fetch/获取）
  const clicked = await E(`(() => {
    const cands = [...document.querySelectorAll('button')].filter(b => /fetch|获取/i.test((b.title || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + b.textContent));
    if (cands.length) { cands[0].click(); return cands.map(c => c.title || c.textContent).join(',').slice(0, 40); }
    return null;
  })()`);
  console.log('fetch clicked:', clicked);

  // 等摘要弹窗（最多 15s）
  let popup = false;
  for (let i = 0; i < 15 && !popup; i++) {
    await sleep(1000);
    popup = await E(`!!document.querySelector('.gg-psum, .gg-modal') && /周报|提交/.test(document.body.textContent)`).catch(() => false);
  }
  console.log('popup:', popup);
  await sleep(800);
  const clip = await page.evaluate(() => {
    const ed = document.querySelector('.part.editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
  });
  if (clip && popup) {
    await page.screenshot({ path: path.join(OUT, 'pull-summary.png'), clip });
    console.log('pull-summary.png:', fs.existsSync(path.join(OUT, 'pull-summary.png')));
  } else {
    console.log('SKIP pull shot');
  }
  gb.ws.close();
  await b.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
