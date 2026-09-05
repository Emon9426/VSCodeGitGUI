/** 第二次移动验证：dirA/g.txt → dirB。node cdp-verify-move2.js <port> */
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
const log = (...a) => console.log(...a);

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
      const has = await rawEval(`(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; return d ? !!d.querySelector('.gg-files, .gg-work') : false; })()`);
      if (has?.result?.result?.value === true) { gb = { ws, rawEval }; break; }
      ws.close();
    }
    if (!gb) await sleep(600);
  }
  if (!gb) { log('FAIL: webview 未找到'); process.exit(1); }
  const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
  const E = (js) => gb.rawEval(W(js)).then(m => m?.result?.result?.value);

  // 文件页 → 地址栏直达 mtest/dirA
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Browse repo files/.test(x.title || x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(900);
  await E(`(() => { document.querySelector('.gg-files-addr-space')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(400);
  await E(`(() => { const i = document.querySelector('.gg-files-addr-input'); if (i) { i.value = 'mtest/dirA'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } return true; })()`);
  await sleep(1600);

  // 选 g.txt → 移动
  const pick = await E(`(() => {
    const rows = [...document.querySelectorAll('.gg-files-row')];
    const row = rows.find(r => (r.textContent || '').includes('g.txt'));
    if (!row) return 'NO_ROW: ' + rows.map(r => r.textContent.trim().slice(0, 20)).join('|');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'picked';
  })()`);
  log('pick:', pick);
  await sleep(400);
  const dlg = await E(`(() => {
    const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => /Move to|移动到/.test(x.textContent || ''));
    if (!b) return 'NO_MOVEBTN';
    if (b.classList.contains('dis')) return 'BTN_DISABLED';
    b.click();
    return 'dlg-open';
  })()`);
  log('move-btn:', dlg);
  await sleep(900);
  const crumbs = await E(`(() => {
    const box = document.querySelector('.gg-move-dlg');
    return box ? [...box.querySelectorAll('.gg-move-crumb')].map(c => c.textContent.trim()).join('>') : 'NO_DLG';
  })()`);
  log('初始面包屑(期望 repo root>mtest>dirA):', crumbs);
  // 面包屑回 mtest 再进 dirB
  const nav = await E(`(() => {
    const box = document.querySelector('.gg-move-dlg');
    if (!box) return 'NO_DLG';
    const crumb = [...box.querySelectorAll('.gg-move-crumb')].find(c => c.textContent.trim() === 'mtest');
    if (crumb) { crumb.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'to-mtest'; }
    return 'NO_CRUMB';
  })()`);
  log('crumb-nav:', nav);
  await sleep(900);
  const enter = await E(`(() => {
    const box = document.querySelector('.gg-move-dlg');
    const row = [...(box?.querySelectorAll('.gg-move-row') ?? [])].find(r => (r.textContent || '').includes('dirB'));
    if (!row) return 'NO_DIR';
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'entered-dirB';
  })()`);
  log('enter:', enter);
  await sleep(900);
  const confirm = await E(`(() => {
    const box = document.querySelector('.gg-move-dlg');
    if (!box) return 'NO_DLG';
    const ok = [...box.querySelectorAll('button')].find(b2 => /Move here|移动到此处/.test(b2.textContent || ''));
    if (!ok) return 'NO_OK';
    if (ok.classList.contains('dis')) return 'OK_DISABLED';
    ok.click();
    return 'confirmed';
  })()`);
  log('confirm:', confirm);
  await sleep(3000);
  const after = await E(`(() => ({
    toast: document.querySelector('.gg-notif')?.textContent.trim().slice(0, 120) || null,
    errDialog: document.querySelector('.gg-modal-overlay')?.textContent.trim().slice(0, 200) || null,
  }))()`);
  log('after:', JSON.stringify(after));
  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
