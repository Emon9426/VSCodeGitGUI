/** README 截图脚本 ②合并冲突：切工作副本 → 冲突横幅/冲突行 → 打开三栏合并器 → 截图 */
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
  await sleep(1000);
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

  // 等 watcher 刷新到冲突状态（自动切工作副本），最多 12s
  let merging = false;
  for (let i = 0; i < 12 && !merging; i++) {
    merging = await E(`!!document.querySelector('.gg-work-confbar, [class*=conflict]') || document.body.textContent.includes('冲突')`).catch(() => false);
    if (!merging) { await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(x => /工作副本|Working/i.test(x.textContent))?.click()`).catch(() => {}); await sleep(1500); }
  }
  console.log('merging state:', merging);
  await sleep(1500);

  // 打开三栏合并器：优先冲突行的「合并…」按钮
  const opened = await E(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /合并|Merge|Resolve|解决/i.test(x.textContent + ' ' + (x.title || '')));
    if (b) { b.click(); return 'btn:' + (b.textContent || b.title); }
    const row = document.querySelector('.gg-work-row.conflict, .gg-work-row');
    if (row) { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'dblclick'; }
    return null;
  })()`);
  console.log('merge open via:', opened);
  await sleep(3500);
  const mv = await E(`!!document.querySelector('.gg-merge, [class*=gg-merge], .gg-mergeview') || (document.body.textContent.includes('合并版本') || document.body.textContent.includes('我的版本'))`);
  console.log('merge view visible:', mv);

  const clip = await page.evaluate(() => {
    const ed = document.querySelector('.part.editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
  });
  if (clip && mv) {
    await page.screenshot({ path: path.join(OUT, 'merge-conflict.png'), clip });
    console.log('merge-conflict.png:', fs.existsSync(path.join(OUT, 'merge-conflict.png')));
  } else {
    console.log('SKIP merge shot, clip=', !!clip, 'mv=', mv);
  }
  gb.ws.close();
  await b.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
