/** 调试 webview iframe 内部结构：node gb-frame-debug.js <port> */
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
  for (let round = 0; round < 3; round++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const frames = list.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl);
    console.log(`round${round}: ${frames.length} iframe targets`);
    for (const t of frames) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) { console.log('  ws not open'); continue; }
      const out = await new Promise(res => {
        let seq = 0; const pending = new Map();
        ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
        const id = ++seq; pending.set(id, res);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(() => {
          const frames = [...document.querySelectorAll('iframe')];
          return JSON.stringify({
            iframeCount: frames.length,
            ids: frames.map(f => f.id),
            activeExists: !!document.querySelector('#active-frame'),
            activeDocReady: !!(document.querySelector('#active-frame') && document.querySelector('#active-frame').contentDocument && document.querySelector('#active-frame').contentDocument.body),
            ggWork: !!(document.querySelector('#active-frame')?.contentDocument?.querySelector?.('.gg-work')),
            bodyCls: document.body ? document.body.className.slice(0, 60) : null,
          });
        })()`, returnByValue: true } }));
        setTimeout(() => res('inner-eval-timeout'), 8000);
      });
      console.log('  probe:', typeof out === 'object' ? JSON.stringify(out.result?.result?.value ?? out) : out);
      ws.close();
    }
    await sleep(1500);
  }
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
