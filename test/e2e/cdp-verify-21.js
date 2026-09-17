/**
 * Issue #21 实机验证：pull 半完成态（fetch 成功 refs 前进 + merge 失败）明示与恢复链路。
 * 前置：fixture %TEMP%/gb21-clone（本地未提交冲突修改，远端领先 1 提交 c2-mate）。
 * 用法：node cdp-verify-21.js <port>
 *
 * 用例：
 *  A1 打开 GitBoard，提交图渲染（c1 在顶）
 *  A2 点 Pull → 失败通知出现，body 含「合并未完成」（半完成态明示，#21 核心）
 *  A3 通知带「重试」与「贮藏并重试」（primary）
 *  A4 通知带可折叠 git 输出（detail）
 *  A5 半完成态视觉：侧栏 main 分支出现 ↓1 徽标（refs 已前进、HEAD 未动）
 *  A6 点「贮藏并重试」→ merge 完成：图顶部变为 c2-mate（完整到手）
 *  B1 added.md 已落地（文件页可见）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9233';
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
  for (let i = 0; i < 12 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const li = ab && [...ab.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return /GitBoard|仓库|Repositories/i.test(a?.getAttribute('aria-label') || a?.title || '');
      });
      if (li) { li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); li.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1200);
  }
  check('GitBoard 面板打开', opened);
  if (!opened) { await b.close(); process.exit(1); }

  let gb = null;
  for (let i = 0; i < 25 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(700);
  }
  if (!gb) { console.log('FAIL | webview 帧未找到'); await b.close(); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await E(`document.querySelectorAll('.gg-row').length > 0`).catch(() => false);
    if (!ready) await sleep(800);
  }
  check('A1 仓库加载（提交图渲染）', ready);

  // ---------- A2：点 Pull → 失败通知（半完成态文案） ----------
  await E(`document.querySelector('.gg-tb-btn[data-kind="pull"]')?.click()`);
  let notif = null;
  for (let i = 0; i < 30 && !notif; i++) {
    await sleep(700);
    notif = await E(`(() => { const n = document.querySelector('.gg-notif.error'); if (!n) return null; return { body: n.querySelector('.gg-notif-body')?.textContent || '', btns: [...n.querySelectorAll('.gg-notif-acts button')].map(b => b.textContent), hasDetail: !!n.querySelector('.gg-notif-detail') }; })()`);
  }
  check('A2 失败通知出现且 body 含「合并未完成」（半完成态明示）', !!notif && /合并未完成|merge did not complete/i.test(notif.body), notif ? notif.body.slice(0, 60) + '…' : 'no notif');
  check('A3 通知动作含 重试 + 贮藏并重试', !!notif && notif.btns.some(x => /重试|retry/i.test(x)) && notif.btns.some(x => /贮藏|stash/i.test(x)), notif ? notif.btns.join(',') : '');
  check('A4 通知带可折叠 git 输出', !!notif && notif.hasDetail);

  // ---------- A5：半完成态视觉——refs 已前进（behind 徽标）、HEAD 未动 ----------
  const badge = await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || ''`);
  check('A5 侧栏 HEAD 分支出现 behind 徽标（refs 已先行更新）', /↓\s*1|d1/i.test(badge), badge);

  // ---------- A6：贮藏并重试 → merge 完成（HEAD 追上 upstream，behind 徽标消失） ----------
  await E(`(() => { const n = document.querySelector('.gg-notif.error'); const btn = n && [...n.querySelectorAll('.gg-notif-acts button')].find(b => /贮藏|stash/i.test(b.textContent)); if (btn) { btn.click(); return true; } return false; })()`);
  let merged = false, mergedDetail = '';
  for (let i = 0; i < 40 && !merged; i++) {
    await sleep(800);
    // 图顶行可能是远端分支提交（fetch 后即显示），不能作 HEAD 前进依据；
    // HEAD 分支的 ahead/behind 徽标消失 = HEAD 已追上 upstream（merge 完成）
    const headBadge = await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || ''`);
    mergedDetail = `badge="${headBadge}"`;
    // stash pop 冲突会自动切 work 视图（图行 display:none 抓不到），badge 消失即 HEAD 追上
    merged = headBadge.trim() === '';
  }
  check('A6 贮藏重试后 HEAD 追上 upstream（merge 完成）', merged, mergedDetail);

  // ---------- B1：added.md 落地（文件页可见） ----------
  await E(`[...document.querySelectorAll('.gg-viewseg button')].find(x => /文件|Files/.test(x.textContent || ''))?.click()`);
  await sleep(1200);
  let items = '';
  for (let i = 0; i < 10; i++) {
    items = await E(`[...document.querySelectorAll('.gg-files-list .gg-files-nm-t')].map(e => e.textContent).join(',')`);
    if (items.includes('added.md')) break;
    await sleep(600);
  }
  check('B1 added.md 已落地（文件页可见）', items.includes('added.md'), items);

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
