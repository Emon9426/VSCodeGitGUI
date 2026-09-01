/**
 * 移动到功能连续两次实测：node cdp-verify-move.js <port>
 * 流程：文件页选 mtest/g.txt → 移动到 mtest/dirA → 再选 → 移动到 mtest/dirB → 检查两轮后文件位置与 UI。
 */
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

async function attach() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools'));
  await page.bringToFront();
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const t = tabs.find(x => /GitBoard/.test(x.textContent || '') && !/Quick/.test(x.textContent || ''));
    if (t) { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t.click(); }
  }).catch(() => undefined);
  await sleep(1500);
  for (let i = 0; i < 15; i++) {
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
        setTimeout(() => res({ result: { result: { value: undefined } } }), 15000);
      });
      const has = await rawEval(`(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; return d ? !!d.querySelector('.gg-app, .gg-work, .gg-files') : false; })()`);
      if (has?.result?.result?.value === true) return { ws, rawEval };
      ws.close();
    }
    await sleep(700);
  }
  return null;
}

(async () => {
  const gb = await attach();
  if (!gb) { log('FAIL: webview 未找到'); process.exit(1); }
  const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
  const E = (js) => gb.rawEval(W(js)).then(m => m?.result?.result?.value);

  // 切到文件页（工具栏 "Browse repo files"）
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Browse repo files|文件/.test(x.title || x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(1000);

  // 导航到 mtest
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Browse repo files/.test(x.title || x.textContent)); return !!b; })()`);
  // 地址栏直达 mtest
  const nav = await E(`(() => {
    const addr = document.querySelector('.gg-files-addr-space, .gg-files-abtn');
    if (!addr) return 'NO_ADDR';
    addr.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'edit-open';
  })()`);
  log('addr-edit:', nav);
  await sleep(400);
  await E(`(() => { const i = document.querySelector('.gg-files-addr-input'); if (i) { i.value = 'mtest'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } return true; })()`);
  await sleep(1500);

  async function moveOnce(fileLabel, dirLabel, tag) {
    // 选中文件行
    const picked = await E(`(() => {
      const rows = [...document.querySelectorAll('.gg-files-row, .gg-files-card')];
      const row = rows.find(r => (r.textContent || '').includes('${fileLabel}'));
      if (!row) return 'NO_ROW: ' + rows.map(r => r.textContent.trim().slice(0, 12)).join('|');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'picked';
    })()`);
    log(`[${tag}] pick:`, picked);
    if (!String(picked).startsWith('picked')) return picked;
    await sleep(400);
    // 点 移动到 按钮
    const dlg = await E(`(() => {
      const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => /Move to|移动到/.test(x.textContent || x.title || ''));
      if (!b) return 'NO_MOVEBTN';
      if (b.classList.contains('dis')) return 'BTN_DISABLED';
      b.click();
      return 'dlg-open';
    })()`);
    log(`[${tag}] move-btn:`, dlg);
    if (dlg !== 'dlg-open') return dlg;
    await sleep(900);
    // 检查对话框：面包屑初始目录
    const crumbs = await E(`(() => {
      const box = document.querySelector('.gg-move-dlg');
      if (!box) return 'NO_DLG';
      return [...box.querySelectorAll('.gg-move-crumb')].map(c => c.textContent.trim()).join('>');
    })()`);
    log(`[${tag}] 初始面包屑:`, crumbs);
    // 进入目标目录行（点击 dirLabel）
    if (dirLabel) {
      const entered = await E(`(() => {
        const box = document.querySelector('.gg-move-dlg');
        if (!box) return 'NO_DLG';
        const row = [...box.querySelectorAll('.gg-move-row')].find(r => (r.textContent || '').includes('${dirLabel}'));
        if (!row) return 'NO_DIR: ' + [...box.querySelectorAll('.gg-move-row')].map(r => r.textContent.trim()).join('|');
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'entered';
      })()`);
      log(`[${tag}] enter dir:`, entered);
      await sleep(900);
    }
    // 点 移动到此处
    const confirmed = await E(`(() => {
      const box = document.querySelector('.gg-move-dlg');
      if (!box) return 'NO_DLG';
      const ok = [...box.querySelectorAll('button')].find(b => /Move here|移动到此处/.test(b.textContent || ''));
      if (!ok) return 'NO_OK';
      if (ok.classList.contains('dis')) return 'OK_DISABLED';
      ok.click();
      return 'confirmed';
    })()`);
    log(`[${tag}] confirm:`, confirmed);
    await sleep(2500);
    const after = await E(`(() => ({
      dlgStillOpen: !!document.querySelector('.gg-move-dlg'),
      toast: document.querySelector('.gg-toast')?.textContent.trim().slice(0, 120) || null,
      errDialog: document.querySelector('.gg-modal-overlay')?.textContent.trim().slice(0, 160) || null,
    }))()`);
    log(`[${tag}] after:`, JSON.stringify(after));
    return confirmed;
  }

  await moveOnce('g.txt', 'dirA', '第1次');
  await moveOnce('g.txt', 'dirB', '第2次');

  const finalState = await E(`(() => ({
    moveBanner: document.querySelector('.gg-move-banner, .gg-mv-banner')?.textContent.trim().slice(0, 100) || null,
  }))()`);
  log('final:', JSON.stringify(finalState));
  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
