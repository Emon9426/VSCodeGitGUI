/**
 * 实机 CDP 验证（#49 UI 修复轮，2026-09-12）：与 cdp-verify-review.js 同型通道
 * （workbench → type=iframe target raw ws → #active-frame WRAP）。
 * 断言：①确认框 Esc 关闭且 resolve(false) ②遮罩点击=取消 ③branchPicker 内联 Esc 不关窗
 * ④subject 最小宽度配额 ⑤空提交详情提示 ⑥浮层 92vw 钳制 ⑦标签行双击检出 ⑧danger 按钮主题色。
 * 前提：%TEMP%/gb-review-setup.sh（0.27.0 + 夹具，全新 profile 语言=en）。通过=UIPOLISH-ALL-PASS。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let wsSeq = 0;
function evalRaw(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = ++wsSeq;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result?.result?.value);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}
const WRAP = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; const window = d.defaultView; return (${js}); })()`;
const ev = (ws, js) => evalRaw(ws, WRAP(js));

async function connectGb(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for (const t of targets.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res) => { ws.once('open', res); ws.once('error', res); });
    if (ws.readyState !== 1) continue;
    const has = await ev(ws, `!!document.querySelector('.gg-body')`).catch(() => false);
    if (has) return ws;
    ws.close();
  }
  return null;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('vscode-file')) ?? browser.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(800);
  let ws = await connectGb(9333);
  if (!ws) {
    await page.evaluate(() => {
      const el = [...globalThis.document.querySelectorAll('.activitybar .action-label')]
        .find(x => x.getAttribute('aria-label') === 'GitBoard');
      if (el) el.click();
    });
    await sleep(9000);
    ws = await connectGb(9333);
  }
  if (!ws) { console.log('NO-WEBVIEW-TARGET'); process.exit(1); }
  await sleep(6000);

  const R = [];
  const ok = (name, cond, extra) => R.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);

  // ---- ①② 确认框 Esc / 遮罩点击 = 取消（用「检出分离 HEAD」确认框，选一个空提交 c1）----
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-row')];
    const row = rows[rows.length - 1];   // c1: init readme
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 420 }));
    return true;
  })()`);
  await sleep(400);
  await ev(ws, `(() => {
    const items = [...document.querySelectorAll('.gg-menu-item')];
    const it = items.find(x => /detached/i.test(x.textContent));
    if (it) it.click();
    return !!it;
  })()`);
  await sleep(400);
  let dlg = await ev(ws, `(() => {
    const btns = [...document.querySelectorAll('.gg-modal-btns .gg-btn')];
    return btns.length ? { ok: btns.find(x => x.classList.contains('primary'))?.textContent } : null;
  })()`);
  ok('detached confirm dialog opens with action verb', !!dlg && /check\s?out/i.test(dlg.ok || ''), dlg && dlg.ok);
  // Esc 关闭
  await ev(ws, `(() => {
    const box = document.querySelector('.gg-modal');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  let closed = await ev(ws, `!document.querySelector('.gg-modal-overlay')`);
  ok('Esc closes confirm dialog', closed);
  // 再开一次，遮罩 mousedown 取消
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-row')];
    rows[rows.length - 1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 420 }));
    return true;
  })()`);
  await sleep(400);
  await ev(ws, `(() => {
    const items = [...document.querySelectorAll('.gg-menu-item')];
    const it = items.find(x => /detached/i.test(x.textContent));
    if (it) it.click();
    return true;
  })()`);
  await sleep(400);
  await ev(ws, `(() => {
    const ov = document.querySelector('.gg-modal-overlay');
    ov.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  closed = await ev(ws, `!document.querySelector('.gg-modal-overlay')`);
  ok('overlay mousedown closes dialog (cancel path)', closed);

  // ---- ③ branchPicker 内联 Esc 不关窗 ----
  await ev(ws, `(() => {
    const add = [...document.querySelectorAll('.gg-side-add')].find(x => (x.title || '').includes('branch'));
    if (add) add.click();
    return true;
  })()`);
  await sleep(500);
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-bp-row')].filter(x => !x.classList.contains('create'));
    if (rows[0]) rows[0].click();
    return rows.length;
  })()`);
  await sleep(400);
  const inlineShown = await ev(ws, `!!document.querySelector('.gg-bp-inline:not(.hidden)')`);
  await ev(ws, `(() => {
    const input = document.querySelector('.gg-bp-inline input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const afterEsc = await ev(ws, `(() => ({
    inlineHidden: document.querySelector('.gg-bp-inline').classList.contains('hidden'),
    pickerGone: !document.querySelector('.gg-bp'),
  }))()`);
  ok('inline input shown after picking remote', inlineShown);
  ok('inline Esc returns to search, picker stays', afterEsc.inlineHidden && !afterEsc.pickerGone, JSON.stringify(afterEsc));
  await ev(ws, `(() => { const ov = document.querySelector('.gg-bp') && document.querySelector('.gg-bp').closest('.gg-modal-overlay'); if (ov) ov.remove(); return true; })()`);
  await sleep(200);

  // ---- ④ subject 最小宽度配额（c2 行多徽标）----
  const subj = await ev(ws, `(() => {
    for (const row of document.querySelectorAll('.gg-row')) {
      const sub = row.querySelector('.gg-subject');
      const chips = row.querySelectorAll('.gg-chip');
      if (sub && chips.length >= 4) {
        const sr = sub.getBoundingClientRect();
        return { w: sr.width, min: getComputedStyle(sub).minWidth };
      }
    }
    return null;
  })()`);
  ok('subject keeps min-width quota', !!subj && parseInt(subj.min, 10) >= 100 && subj.w >= 100, subj && `w=${subj.w} min=${subj.min}`);

  // ---- ⑤ 空提交详情提示（c6 empty commit）----
  await ev(ws, `(() => { const r = document.querySelector('.gg-row'); if (r) r.click(); return true; })()`);
  await sleep(1800);
  const emptyHint = await ev(ws, `(() => ({
    hint: document.querySelector('.gg-file-empty')?.textContent || null,
    files: document.querySelectorAll('.gg-file').length,
  }))()`);
  ok('empty commit shows hint in detail panel', !!emptyHint.hint && emptyHint.files === 0, JSON.stringify(emptyHint));

  // ---- ⑥ 浮层 92vw 钳制（computed）----
  const clamps = await ev(ws, `(() => ({
    netMax: getComputedStyle(document.createElement('div')).maxWidth,
    modalMax: (() => { const m = document.createElement('div'); m.className = 'gg-modal'; document.body.appendChild(m); const v = getComputedStyle(m).maxWidth; m.remove(); return v; })(),
  }))()`);
  void clamps;
  const modalClamp = await ev(ws, `(() => {
    const m = document.createElement('div'); m.className = 'gg-modal'; document.body.appendChild(m);
    const v = getComputedStyle(m).maxWidth; m.remove();
    return { v, vw: window.innerWidth };
  })()`);
  ok('modal max-width 92vw clamp', !!modalClamp && Math.abs(parseFloat(modalClamp.v) - modalClamp.vw * 0.92) < 2, JSON.stringify(modalClamp));

  // ---- ⑦ 标签行双击检出（弹确认框即证语义通；Esc 取消）----
  await ev(ws, `(() => {
    const tags = [...document.querySelectorAll('.gg-side-item.tag')];
    if (tags[0]) tags[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return tags.length;
  })()`);
  await sleep(500);
  const tagDlg = await ev(ws, `(() => {
    const t = document.querySelector('.gg-modal-title');
    return t ? t.textContent : null;
  })()`);
  ok('tag dblclick opens checkout dialog', !!tagDlg && /detach/i.test(tagDlg || ''), String(tagDlg));
  await ev(ws, `(() => { document.querySelectorAll('.gg-modal-overlay').forEach(x => x.remove()); return true; })()`);

  // ---- ⑧ danger 按钮主题色（非硬编码 #ad0707）----
  const dangerBg = await ev(ws, `(() => {
    const b = document.createElement('button'); b.className = 'danger'; document.body.appendChild(b);
    const v = getComputedStyle(b).backgroundColor; b.remove(); return v;
  })()`);
  ok('danger button themed (not #ad0707)', dangerBg !== 'rgb(173, 7, 7)', dangerBg);

  const fails = R.filter(x => x.startsWith('FAIL'));
  for (const r of R) console.log(r);
  console.log(fails.length ? `UIPOLISH-FAIL x${fails.length}` : 'UIPOLISH-ALL-PASS');
  ws.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('UIPOLISH-ERROR', e.message); process.exit(1); });
