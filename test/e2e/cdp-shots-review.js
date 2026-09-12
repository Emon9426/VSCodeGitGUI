/**
 * 实机截图（UI 审查轮，2026-09-12）：workbench page.screenshot 截主要界面到 test/e2e/shots-review/。
 * 通道与 cdp-verify-review.js 同型（type=iframe target + raw ws + WRAP）。手动运行。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

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
  const outDir = path.join(__dirname, 'shots-review');
  fs.mkdirSync(outDir, { recursive: true });
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
  const shot = async (name) => {
    await page.screenshot({ path: path.join(outDir, name) });
    console.log('shot', name);
  };

  // 1 主界面（提交图 + 徽标/标签）：点首行让详情面板展开
  await ev(ws, `(() => { const r = document.querySelector('.gg-row'); if (r) r.click(); return true; })()`);
  await sleep(1500);
  await shot('01-main-graph.png');

  // 2 检出选择器
  await ev(ws, `(() => { const add = [...document.querySelectorAll('.gg-side-add')].find(x => (x.title || '').includes('branch')); if (add) add.click(); return true; })()`);
  await sleep(700);
  await shot('02-checkout-picker.png');
  await ev(ws, `(() => { const ov = document.querySelector('.gg-bp') && document.querySelector('.gg-bp').closest('.gg-modal-overlay'); if (ov) ov.remove(); return true; })()`);
  await sleep(300);

  // 3 分支右键菜单
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-side-item.branch')];
    const row = rows.find(x => x.title.startsWith('feature/login'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 350 }));
    return true;
  })()`);
  await sleep(500);
  await shot('03-branch-menu.png');
  await ev(ws, `(() => { document.querySelectorAll('.gg-menu').forEach(x => x.remove()); return true; })()`);
  await sleep(300);

  // 4 fetch 阻塞弹窗（点击后立即轮询抓拍）
  await ev(ws, `document.querySelector('.gg-tb-btn[data-kind="fetch"]').click(), true`);
  for (let i = 0; i < 40; i++) {
    const vis = await ev(ws, `!!document.querySelector('.gg-net-overlay')`);
    if (vis) { await shot('04-net-modal.png'); break; }
    await sleep(60);
  }
  await sleep(1500);
  // 关掉可能残留的 modal
  await ev(ws, `(() => { document.querySelectorAll('.gg-net-overlay').forEach(x => x.remove()); return true; })()`);

  // 5 pull → 拉取摘要弹窗
  await ev(ws, `document.querySelector('.gg-tb-btn[data-kind="pull"]').click(), true`);
  await sleep(6000);   // pull 完成 + collectPullSummary 弹窗
  await shot('05-pull-summary.png');
  await ev(ws, `(() => { const ov = document.querySelector('.gg-psum-modal') && document.querySelector('.gg-psum-modal').closest('.gg-modal-overlay'); if (ov) ov.remove(); return true; })()`);
  await sleep(400);

  // 6 工作副本视图
  await ev(ws, `(() => {
    const segs = [...document.querySelectorAll('.gg-viewseg')];
    const seg = segs.find(x => /working/i.test(x.textContent) || /工作副本/.test(x.textContent)) || segs[2];
    if (seg) seg.click();
    return true;
  })()`);
  await sleep(1200);
  await shot('06-work-view.png');

  // 7 文件历史视图
  await ev(ws, `(() => {
    const segs = [...document.querySelectorAll('.gg-viewseg')];
    const seg = segs.find(x => /files|文件/i.test(x.textContent)) || segs[3];
    if (seg) seg.click();
    return true;
  })()`);
  await sleep(1200);
  await shot('07-files-view.png');

  // 8 删除分支确认框（danger 对话框样态）
  await ev(ws, `(() => {
    const segs = [...document.querySelectorAll('.gg-viewseg')];
    if (segs[0]) segs[0].click();
    return true;
  })()`);
  await sleep(800);
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-side-item.branch')];
    const row = rows.find(x => x.title.startsWith('wip-unmerged'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 350 }));
    return true;
  })()`);
  await sleep(400);
  await ev(ws, `(() => {
    const items = [...document.querySelectorAll('.gg-menu-item')];
    const it = items.find(x => x.textContent.includes('Delete Branch') && !x.classList.contains('disabled'));
    if (it) it.click();
    return true;
  })()`);
  await sleep(600);
  await shot('08-delete-confirm.png');
  await ev(ws, `(() => { document.querySelectorAll('.gg-modal-overlay').forEach(x => x.remove()); document.querySelectorAll('.gg-menu').forEach(x => x.remove()); return true; })()`);

  // 9 通知区（触发一条 info）
  await ev(ws, `(() => { document.querySelector('.gg-tb-btn[data-kind="refresh"]').click(); return true; })()`);
  await sleep(2500);
  await shot('09-after-refresh.png');

  console.log('SHOTS-DONE');
  ws.close();
  process.exit(0);
})().catch(e => { console.log('SHOTS-ERROR', e.message); process.exit(1); });
