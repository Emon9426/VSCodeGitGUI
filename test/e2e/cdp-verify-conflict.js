/**
 * 冲突解决链路真机验证（隔离 profile + CDP）。
 * 用法：node cdp-verify-conflict.js <port> <phase>
 *   inspect   – 快照冲突横幅/冲突行/按钮几何
 *   theirs    – 点冲突行最后一个按钮（以远端为准），报告前后状态
 *   merge     – 点「合并…」打开合并器，快照三栏/二进制卡片
 *   openwork  – 仅切到工作副本视图（点工具栏分段）
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
const PHASE = process.argv[3] || 'inspect';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();

  // 面板可能已打开（复用场景）：先点 GitBoard tab 激活，兜底 Ctrl+Shift+P
  const tabClicked = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const t = tabs.find(x => /GitBoard/.test(x.textContent || '') && !/Quick/.test(x.textContent || ''));
    if (t) { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t.click(); return true; }
    return false;
  });
  console.log('tab-clicked:', tabClicked);
  if (!tabClicked) {
    await page.keyboard.press('Control+Shift+P');
    await sleep(700);
    await page.keyboard.type('GitBoard: Open', { delay: 40 });
    await sleep(700);
    await page.keyboard.press('Enter');
    await sleep(2000);
  }
  console.log('panel-open attempted');

  // 找 GitBoard 主 webview 帧（.gg-work）
  let gb = null;
  for (let i = 0; i < 20 && !gb; i++) {
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
      const has = await rawEval(`(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; return d ? !!d.querySelector('.gg-work') : false; })()`);
      if (has?.result?.result?.value === true) { gb = { ws, rawEval }; break; }
      ws.close();
    }
    if (!gb) await sleep(600);
  }
  if (!gb) { console.log('FAIL: gitboard webview 未找到'); process.exit(1); }
  console.log('webview-found');

  const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; const window = d.defaultView; return (${js}); })()`;
  const E = (js) => gb.rawEval(W(js)).then(m => m?.result?.result?.value);

  // 切到工作副本视图（工具栏分段「工作副本」）
  const switched = await E(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /Working Copy|工作副本/.test(x.title || x.textContent));
    if (b) { b.click(); return true; }
    return 'no-btn: ' + btns.slice(0, 30).map(x => x.title).filter(Boolean).join('|');
  })()`);
  console.log('switch-work-view:', switched);
  await sleep(1500);

  const snapExpr = `(() => {
    const q = s => document.querySelector(s);
    const qa = s => [...document.querySelectorAll(s)];
    return JSON.stringify({
      banner: q('.gg-merge-banner:not(.hidden)')?.textContent.trim().slice(0, 120) || null,
      bannerBtns: qa('.gg-merge-banner:not(.hidden) button').map(b => b.textContent.trim()),
      conflictRows: qa('.gg-work-row.conflict').map(r => ({
        path: r.querySelector('.gg-work-fpath')?.title || r.textContent.slice(0, 50),
        btns: [...r.querySelectorAll('.gg-work-cbtns button')].map(b => b.textContent.trim()),
        rects: [...r.querySelectorAll('.gg-work-cbtns button')].map(b => { const rc = b.getBoundingClientRect(); const row = r.getBoundingClientRect(); return { x: Math.round(rc.x), w: Math.round(rc.width), inRow: rc.right <= row.right + 1 && rc.left >= row.left - 1, h: Math.round(rc.height) }; }),
      })),
      mergeVisible: !q('.gg-merge')?.classList.contains('hidden'),
      mergeSpecial: q('.gg-merge:not(.hidden) .gg-merge-special')?.textContent.trim().slice(0, 100) || null,
      mergeCards: qa('.gg-merge:not(.hidden) .gg-merge-card').map(c => c.textContent.trim().slice(0, 80)),
      mergeCols: qa('.gg-merge:not(.hidden) .gg-merge-col').length,
      toast: q('.gg-toast')?.textContent.trim().slice(0, 150) || null,
      opstatus: q('.gg-opstatus:not(.off)')?.textContent.trim().slice(0, 120) || null,
      groups: qa('.gg-work-group-h').filter(h => !h.classList.contains('hidden')).map(h => h.textContent.trim().slice(0, 24)),
    });
  })()`;

  if (PHASE === 'inspect') {
    console.log('SNAP:', await E(snapExpr));
  }

  if (PHASE === 'theirs') {
    const before = JSON.parse(await E(snapExpr));
    const clicked = await E(`(() => {
      const row = document.querySelector('.gg-work-row.conflict');
      if (!row) return 'NO_ROW';
      const btns = [...row.querySelectorAll('.gg-work-cbtns button')];
      const t = btns[btns.length - 1];
      if (!t) return 'NO_BTN';
      t.click();
      return 'clicked: ' + t.textContent.trim();
    })()`);
    console.log('CLICK:', clicked);
    await sleep(2500);
    const after = JSON.parse(await E(snapExpr));
    console.log('BEFORE rows:', before.conflictRows.length, 'AFTER rows:', after.conflictRows.length);
    console.log('AFTER-SNAP:', JSON.stringify(after));
  }

  if (PHASE === 'merge') {
    const clicked = await E(`(() => {
      const row = document.querySelector('.gg-work-row.conflict');
      if (!row) return 'NO_ROW';
      const btns = [...row.querySelectorAll('.gg-work-cbtns button')];
      const t = btns.find(b => /Merge|合并/.test(b.textContent));
      if (!t) return 'NO_MERGE_BTN: ' + btns.map(b => b.textContent).join('|');
      t.click();
      return 'clicked: ' + t.textContent.trim();
    })()`);
    console.log('CLICK:', clicked);
    await sleep(2000);
    console.log('SNAP:', await E(snapExpr));
  }

  gb.ws.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
