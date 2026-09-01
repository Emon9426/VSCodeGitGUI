/** README 截图脚本 ①核心视图：提交图总览（GitHub 风+详情）/ 纯提交 / 工作副本 / 文件页 / 右键菜单 / 筛选
 *  截图裁剪到 GitBoard webview 区域（产品级画面，无 VS Code 外框）。 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const PORT = (() => {
  const raw = process.argv[2] || '9232';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
  return raw;
})();
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'res/screenshots';
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'OK  ' : 'MISS') + ' | ' + name + (detail ? ' | ' + detail : '')); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const li = ab && [...ab.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return a && (a.getAttribute('aria-label') || '').includes('GitBoard');
      });
      if (li) { li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); li.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1500);
  }
  check('GitBoard 打开', opened);
  await sleep(6000);

  let gb = null;
  for (let i = 0; i < 15 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(1000);
  }
  if (!gb) { console.log('FAIL: no webview'); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  const ver = await E(`document.body.textContent.match(/0\\.14\\.\\d+/)?.[0] || 'NONE'`);
  check('版本 0.14.6', ver === '0.14.6', ver);
  const lang = await E(`document.querySelector('.gg-viewseg-btn') ? [...document.querySelectorAll('.gg-viewseg-btn')].map(b=>b.textContent.trim()).join('/') : '?'`);
  check('界面语言', /图|Graph/.test(lang), lang);

  // webview 区域裁剪坐标（工作台主帧的编辑器区域 = GitBoard 面板所在）
  const clipOf = () => page.evaluate(() => {
    const ed = document.querySelector('.part.editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const shot = async (name) => {
    const c = await clipOf();
    if (!c) { check(name, false, 'no frame'); return; }
    await page.screenshot({ path: path.join(OUT, name), clip: c });
    check(name, fs.existsSync(path.join(OUT, name)));
  };

  // ---- ① 提交图总览：默认图视图（GitHub 风多分支），选中一个合并提交展开详情 ----
  await sleep(2500);
  await E(`(() => { const rows = [...document.querySelectorAll('.gg-list .gg-row')]; const m = rows.find(r => (r.querySelector('.gg-subject')||{}).textContent?.includes('Merge hotfix')); if (m) m.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!m; })()`);
  await sleep(1800);
  // 点开一个变更文件显示内联 diff
  await E(`(() => { const f = document.querySelector('.gg-dfiles .gg-file'); if (f) f.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!f; })()`);
  await sleep(1500);
  await shot('overview.png');

  // ---- ② 纯提交视图 ----
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /纯提交|Pure/i.test(b.textContent))?.click()`);
  await sleep(2000);
  await shot('pure-view.png');
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /提交图|Graph/i.test(b.textContent) && !/纯/.test(b.textContent))?.click()`);
  await sleep(1500);

  // ---- ③ 工作副本：三态 + 分组 + 提交栏 ----
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /工作副本|Working/i.test(b.textContent))?.click()`);
  await sleep(2200);
  await E(`(() => { const r = document.querySelector('.gg-work-row'); if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!r; })()`);
  await sleep(1500);
  await shot('working-copy.png');

  // ---- ④ 文件历史页：进入子目录 + 选中文件显示历史 ----
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /文件|Files/i.test(b.textContent))?.click()`);
  await sleep(2200);
  // 双击进入“已完成”
  await E(`(() => { const rows = [...document.querySelectorAll('.gg-files-table .gg-files-row')]; const t = rows.find(r => (r.querySelector('.gg-files-nm-t')||{}).textContent === '已完成'); if (t) t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return !!t; })()`);
  await sleep(1800);
  // 点选需求文档.md → 右区历史
  await E(`(() => { const rows = [...document.querySelectorAll('.gg-files-table .gg-files-row')]; const t = rows.find(r => /需求文档/.test(r.textContent)); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!t; })()`);
  await sleep(2500);
  await shot('file-history.png');

  // ---- ⑤ 右键菜单（提交行）----
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => /提交图|Graph/i.test(b.textContent) && !/纯/.test(b.textContent))?.click()`);
  await sleep(2000);
  await E(`(() => { const r = document.querySelector('.gg-list .gg-row'); if (!r) return false; const rc = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rc.x + 120, clientY: rc.y + 8 })); return true; })()`);
  await sleep(700);
  await shot('operations.png');
  await E(`(() => { document.querySelectorAll('.gg-ctx, .gg-menu, [class*=ctx]').forEach(e => e.remove()); return true; })()`);
  await sleep(300);

  // ---- ⑥ 筛选：作者下拉打开 ----
  await E(`(() => { const btn = [...document.querySelectorAll('button')].find(b => /作者|Author/i.test(b.title || '') || /作者|Author/i.test(b.textContent)); if (btn) btn.click(); return !!btn; })()`);
  await sleep(900);
  await shot('filters.png');
  await E(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(300);

  console.log(results.every(r => r.pass) ? 'SHOTS-CORE-ALL-OK' : 'SHOTS-CORE-PARTIAL');
  gb.ws.close();
  await b.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
