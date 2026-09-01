/** 查 webview 视图状态：node gb-view-debug.js <port> */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const f = list.find(x => x.type === 'iframe');
  if (!f) { console.log('NO_IFRAME'); process.exit(1); }
  const ws = new WebSocket(f.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => { ws.once('open', r); ws.once('error', r); });
  const expr = `(function(){
    const d = globalThis.document.querySelector('#active-frame')?.contentDocument;
    if (!d) return 'NO_FRAME';
    const segBtns = [...d.querySelectorAll('button')]
      .filter(x => /Working Copy|工作副本|Pure|Browse|Commit graph/.test(x.title || x.textContent))
      .map(x => ({ t: (x.title || x.textContent).slice(0, 34), on: (x.className || '').includes('on') }));
    return JSON.stringify({
      view: d.body.className,
      mergeHidden: d.querySelector('.gg-merge')?.classList.contains('hidden'),
      workParentCls: d.querySelector('.gg-work')?.parentElement?.className,
      filesW: d.querySelector('.gg-work-files') ? Math.round(d.querySelector('.gg-work-files').getBoundingClientRect().width) : null,
      segBtns,
    });
  })()`;
  const out = await new Promise(res => {
    const id = 1;
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    setTimeout(() => res('TIMEOUT'), 8000);
  });
  console.log(out);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
