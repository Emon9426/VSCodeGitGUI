/** 二进制卡片点 Take mine/Theirs 后验证内容选侧：node cdp-verify-binpick.js <port> <mine|theirs> */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const SIDE = process.argv[3] === 'theirs' ? 'theirs' : 'mine';
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

  // 切工作副本 + 打开第一个冲突的合并器（blob.bin）
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Working Copy|工作副本/.test(x.title || x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(800);
  const opened = await E(`(() => {
    const row = [...document.querySelectorAll('.gg-work-row.conflict')].find(r => /blob/.test(r.querySelector('.gg-work-fpath')?.title || ''));
    if (!row) return 'NO_BLOB_ROW';
    const b = [...row.querySelectorAll('button')].find(x => /Merge|合并/.test(x.textContent));
    if (!b) return 'NO_MERGE_BTN';
    b.click(); return 'opened';
  })()`);
  console.log('open-merge:', opened);
  await sleep(1500);

  // 找二进制卡片并点 Take mine / Take theirs
  const clicked = await E(`(() => {
    const cards = [...document.querySelectorAll('.gg-merge:not(.hidden) .gg-merge-card')];
    if (!cards.length) return 'NO_CARDS';
    const card = cards[${SIDE === 'mine' ? '0' : '1'}];
    const title = card.querySelector('.gg-merge-card-t')?.textContent;
    const btn = [...card.querySelectorAll('button')].find(x => /Take|用我|用对方/.test(x.textContent));
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'clicked "' + title + '" -> ' + btn.textContent.trim();
  })()`);
  console.log('CLICK:', clicked);
  await sleep(2500);
  const after = await E(`(() => ({
    conflicts: [...document.querySelectorAll('.gg-work-row.conflict')].map(r => r.querySelector('.gg-work-fpath')?.title),
    mergeOpen: !document.querySelector('.gg-merge')?.classList.contains('hidden'),
    mergeTitle: document.querySelector('.gg-merge:not(.hidden) .gg-merge-fname')?.textContent,
    toast: document.querySelector('.gg-toast')?.textContent.trim().slice(0, 120) || null,
  }))()`);
  console.log('AFTER:', JSON.stringify(after));
  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
