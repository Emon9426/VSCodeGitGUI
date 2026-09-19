/**
 * Issue #75 实机回归（L2：非 git 目录——工程目录功能完全脱离 git 的场景）。
 * 前置：VS Code 已用 0.30.0 vsix + 全新 profile 打开 gb75/nogit（非 git 文件夹），
 *       CDP 端口运行中。用法：node cdp-verify-75n.js <port>
 *
 * 用例：
 *  B1 主区空态 = 无仓库引导（标题+副文案），侧栏仓库区 = 无仓库文案
 *  B2 ＋→保存当前工作区→命名确认 → 工程行出现（无 git 参与的完整链路）
 *  B3 右键工程行 → 移除（danger 确认） → 工程行消失、列表回空态
 *  B4 全程无 error 通知/toast（git 可用、仅无仓库，不应报 gitNotFound）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9238';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();

  let opened = false;
  for (let i = 0; i < 15 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const li = ab && [...ab.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return /GitBoard/i.test(a?.getAttribute('aria-label') || a?.title || '');
      });
      if (li) { li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); li.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1000);
  }
  check('GitBoard 面板打开（活动栏）', opened);
  if (!opened) { await b.close(); process.exit(1); }

  let gb = null;
  for (let i = 0; i < 30 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(500);
  }
  if (!gb) { console.log('FAIL | webview 帧未找到'); await b.close(); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // 等扫描收尾（无仓库 → reposChanged(空) → 引导）
  await sleep(3000);

  // ---------- B1：无仓库引导 ----------
  const st = await E(`(() => {
    const e = document.querySelector('.gg-empty');
    return {
      show: e?.classList.contains('show'),
      title: e?.querySelector('.gg-empty-title')?.textContent || '',
      hint: (e?.querySelector('.gg-empty-hint')?.textContent || ''),
      repoEmpty: (document.querySelectorAll('.gg-side-sec')[1] || {}).querySelector?.('.gg-side-empty')?.textContent || '',
    };
  })()`).catch(() => ({}));
  check('B1a 主区空态=无仓库引导', st.show === true && /No Git repository found|当前工作区未发现/.test(st.title || ''), st.title);
  check('B1b 侧栏仓库区=无仓库文案', /No Git repository found|No repos|当前工作区未发现|未发现/.test(st.repoEmpty || ''), st.repoEmpty);

  // ---------- B2：保存当前工作区为工程 ----------
  await E(`document.querySelector('.gg-side-add')?.click()`);
  let menuOk = false;
  for (let i = 0; i < 10 && !menuOk; i++) {
    menuOk = await E(`(() => {
      const items = [...document.querySelectorAll('.gg-menu-item')].filter(x => /保存当前工作区|Save current workspace/.test(x.textContent || ''));
      const it = items.find(x => !x.classList.contains('disabled'));
      if (it) { it.click(); return true; }
      return false;
    })()`).catch(() => false);
    if (!menuOk) await sleep(300);
  }
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    ok = await E(`(() => { const m = document.querySelector('.gg-modal'); const b = m && m.querySelector('.gg-modal-btns .gg-btn.primary'); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
    if (!ok) await sleep(300);
  }
  let projRows = 0;
  for (let i = 0; i < 30 && projRows === 0; i++) {
    projRows = await E(`document.querySelectorAll('.gg-side-item.project').length`).catch(() => 0);
    if (!projRows) await sleep(200);
  }
  check('B2 非仓库目录下保存工程成功（行出现）', projRows > 0, `rows=${projRows}`);

  // ---------- B3：右键移除工程 ----------
  await E(`(() => { const r = document.querySelector('.gg-side-item.project'); if (r) r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return !!r; })()`);
  let rmClicked = false;
  for (let i = 0; i < 10 && !rmClicked; i++) {
    rmClicked = await E(`(() => {
      const items = [...document.querySelectorAll('.gg-menu-item')];
      const it = items.find(x => /^\\s*(移除|Remove)/.test(x.textContent || ''));
      if (it) { it.click(); return true; }
      return false;
    })()`).catch(() => false);
    if (!rmClicked) await sleep(300);
  }
  let dangerOk = false;
  for (let i = 0; i < 10 && !dangerOk; i++) {
    dangerOk = await E(`(() => { const b = document.querySelector('.gg-modal .gg-modal-btns .gg-btn.danger'); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
    if (!dangerOk) await sleep(300);
  }
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    const n = await E(`document.querySelectorAll('.gg-side-item.project').length`).catch(() => -1);
    if (n === 0) removed = true; else await sleep(300);
  }
  check('B3 右键移除工程（danger 确认）→ 行消失', rmClicked && dangerOk && removed, `menu=${rmClicked}, danger=${dangerOk}, removed=${removed}`);

  // ---------- B4：零错误 ----------
  const errs = await E(`document.querySelectorAll('.gg-notif.error').length`).catch(() => 0);
  const toastErrs = await E(`document.querySelectorAll('.gg-toast.error').length`).catch(() => 0);
  const notifTitles = await E(`[...document.querySelectorAll('.gg-notif')].map(n => n.querySelector('.gg-notif-title')?.textContent || '').join(' | ')`).catch(() => '');
  check('B4 全程无 error 通知/toast（git 可用，仅无仓库不报 gitNotFound）', errs === 0 && toastErrs === 0, notifTitles.slice(0, 80));

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  console.log(fail ? 'VERIFY-75N FAIL' : 'VERIFY-75N ALL-PASS');
  try { gb.ws.close(); } catch { /* ignore */ }
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
