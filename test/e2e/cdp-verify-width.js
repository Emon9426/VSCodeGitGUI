/** 列宽拖拽验证：拖到 >420px 并检查。node cdp-verify-width.js <port> [restore]
 *  restore 模式：只读取当前宽度（重启恢复验证用）。 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const MODE = process.argv[4] || 'drag';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools'));
  await page.bringToFront();
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const t = tabs.find(x => /GitBoard/.test(x.textContent || '') && !/Quick/.test(x.textContent || ''));
    if (t) { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t.click(); }
  }).catch(() => undefined);
  await sleep(1200);
  let gb = null;
  for (let i = 0; i < 15 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      let seq = 0; const pending = new Map();
      ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
      const rawEval = (expr) => new Promise(res => {
        const id = ++seq; pending.set(id, res);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        setTimeout(() => res({ result: { result: { value: undefined } } }), 12000);
      });
      const has = await rawEval(`(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; return d ? !!d.querySelector('.gg-work-files') : false; })()`);
      if (has?.result?.result?.value === true) { gb = { ws, rawEval }; break; }
      ws.close();
    }
    if (!gb) await sleep(600);
  }
  if (!gb) { console.log('FAIL: webview 未找到'); process.exit(1); }
  const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; const window = d.defaultView; return (${js}); })()`;
  const E = (js) => gb.rawEval(W(js)).then(m => m?.result?.result?.value);

  // 关掉可能残留的合并器，再切工作副本视图（注意按钮 title 为 "Working copy" 小写 c）
  await E(`(() => {
    const close = document.querySelector('.gg-merge:not(.hidden) .gg-merge-close');
    if (close) close.click();
    const b = [...document.querySelectorAll('button')].find(x => /Working [Cc]opy|工作副本/.test(x.title || x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);

  if (process.argv[3] === 'restore') {
    const st = await E(`(() => ({ width: Math.round(document.querySelector('.gg-work-files').getBoundingClientRect().width), rootW: Math.round(document.querySelector('.gg-work').clientWidth) }))()`);
    console.log('RESTORED:', JSON.stringify(st));
  } else {
    const before = await E(`(() => {
      const f = document.querySelector('.gg-work-files');
      const r = document.querySelector('.gg-work-resizer');
      return JSON.stringify({ w: Math.round(f.getBoundingClientRect().width), rootW: Math.round(document.querySelector('.gg-work').clientWidth), hasResizer: !!r });
    })()`);
    console.log('BEFORE:', before);
    // 拖拽 resizer：pointerdown → 多步 pointermove（+340px）→ pointerup
    const drag = await E(`(async () => {
      const r = document.querySelector('.gg-work-resizer');
      if (!r) return 'NO_RESIZER';
      const rect = r.getBoundingClientRect();
      const x0 = rect.x + rect.width / 2, y0 = rect.y + rect.height / 2;
      const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y0, pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
      r.dispatchEvent(mk('pointerdown', x0));
      for (let i = 1; i <= 10; i++) {
        document.defaultView.dispatchEvent ? window.dispatchEvent(mk('pointermove', x0 + 34 * i)) : null;
        await new Promise(rs => setTimeout(rs, 16));
      }
      window.dispatchEvent(mk('pointerup', x0 + 340));
      await new Promise(rs => setTimeout(rs, 300));
      return Math.round(document.querySelector('.gg-work-files').getBoundingClientRect().width);
    })()`);
    console.log('AFTER-DRAG width:', drag);
    // 再拖 100px 验证可持续拉宽（超 420 旧上限）
    const drag2 = await E(`(async () => {
      const r = document.querySelector('.gg-work-resizer');
      const rect = r.getBoundingClientRect();
      const x0 = rect.x + rect.width / 2, y0 = rect.y + rect.height / 2;
      const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y0, pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
      r.dispatchEvent(mk('pointerdown', x0));
      for (let i = 1; i <= 8; i++) { window.dispatchEvent(mk('pointermove', x0 + 15 * i)); await new Promise(rs => setTimeout(rs, 16)); }
      window.dispatchEvent(mk('pointerup', x0 + 120));
      await new Promise(rs => setTimeout(rs, 300));
      return Math.round(document.querySelector('.gg-work-files').getBoundingClientRect().width);
    })()`);
    console.log('AFTER-DRAG2 width:', drag2);
    await sleep(800);   // 等 saveLayout rpc 落库
  }
  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
