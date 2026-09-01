/** 文本三栏合并器检查+块操作验证：node cdp-verify-textmerge.js <port> */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
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
      const has = await rawEval(`(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; return d ? !!d.querySelector('.gg-work') : false; })()`);
      if (has?.result?.result?.value === true) { gb = { ws, rawEval }; break; }
      ws.close();
    }
    if (!gb) await sleep(600);
  }
  if (!gb) { console.log('FAIL: webview 未找到'); process.exit(1); }

  const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
  const E = (js) => gb.rawEval(W(js)).then(m => m?.result?.result?.value);

  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Working Copy|工作副本/.test(x.title || x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(800);

  // 关掉可能开着的合并器（切文件的 open 会自动 flush）
  const opened = await E(`(() => {
    const close = document.querySelector('.gg-merge:not(.hidden) .gg-merge-close');
    if (close) close.click();
    const row = document.querySelector('.gg-work-row.conflict');
    if (!row) return 'NO_ROW';
    const path = row.querySelector('.gg-work-fpath')?.title;
    const b = [...row.querySelectorAll('button')].find(x => /Merge|合并/.test(x.textContent));
    if (!b) return 'NO_MERGE_BTN';
    b.click(); return 'opened:' + path;
  })()`);
  console.log('open-merge:', opened);
  await sleep(1800);

  const state = await E(`(() => ({
    fname: document.querySelector('.gg-merge:not(.hidden) .gg-merge-fname')?.textContent,
    cols: document.querySelectorAll('.gg-merge:not(.hidden) .gg-merge-col').length,
    colHeads: [...document.querySelectorAll('.gg-merge:not(.hidden) .gg-merge-colh b')].map(b => b.textContent),
    chunkBars: document.querySelectorAll('.gg-merge:not(.hidden) .gg-mchunk-bar').length,
    chunkBtns: [...document.querySelectorAll('.gg-merge:not(.hidden) .gg-mchunk-bar .gg-mchunk-btn')].map(b => b.textContent.trim()),
    mineLines: [...document.querySelectorAll('.gg-merge:not(.hidden) .gg-merge-col.mine .gg-ml')].map(r => r.textContent.trim()).filter(Boolean).slice(0, 6),
    resultLines: [...document.querySelectorAll('.gg-merge:not(.hidden) .gg-merge-col.result .gg-ml')].map(r => r.textContent.trim()).filter(Boolean).slice(0, 8),
    finishDisabled: document.querySelector('.gg-merge:not(.hidden) .gg-btn.primary')?.disabled,
    footMsg: document.querySelector('.gg-merge:not(.hidden) .gg-merge-footmsg')?.textContent,
  }))()`);
  console.log('MERGE-STATE:', JSON.stringify(state, null, 1));

  // 点第一个块的 "Use mine"（用我的）
  const applied = await E(`(() => {
    const bar = document.querySelector('.gg-merge:not(.hidden) .gg-mchunk-bar');
    if (!bar) return 'NO_BAR';
    const btn = [...bar.querySelectorAll('button')].find(x => /Use mine|用我的/.test(x.textContent));
    if (!btn) return 'NO_BTN: ' + [...bar.querySelectorAll('button')].map(x => x.textContent).join('|');
    btn.click();
    return 'applied:' + btn.textContent.trim();
  })()`);
  console.log('APPLY:', applied);
  await sleep(2200);
  const afterApply = await E(`(() => ({
    resolvedBars: document.querySelectorAll('.gg-merge:not(.hidden) .gg-mresolved').length,
    remainingBars: document.querySelectorAll('.gg-merge:not(.hidden) .gg-mchunk-bar').length,
    footMsg: document.querySelector('.gg-merge:not(.hidden) .gg-merge-footmsg')?.textContent,
    finishDisabled: document.querySelector('.gg-merge:not(.hidden) .gg-btn.primary')?.disabled,
  }))()`);
  console.log('AFTER-APPLY:', JSON.stringify(afterApply));
  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
