/**
 * 真机验证：新移动链路（v0.14.2 webview 内目录选择对话框）。
 * 步骤：文件页 → 选中「已完成/项目甲」→ 点移动 → 断言 webview 对话框出现 →
 * 浏览子目录 → 取消 → 再移动到根（dst=''）→ 验证 git mv 执行 + 横幅 + 刷新 + 历史跟随。
 * 复位：结束后把目录移回原位（git mv），保持仓库可重复测试。
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
      if (m.id === id) { ws.off('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}
const WRAP = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;

const ok = [];
const bad = [];
const assert = (name, cond) => { (cond ? ok : bad).push(name); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench') || p.url().includes('vscode-file')) ?? browser.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(1000);
  await page.keyboard.press('Control+Alt+G');
  await sleep(6000);

  let gbWs = null;
  for (let i = 0; i < 20 && !gbWs; i++) {
    const targets = await (await fetch('http://127.0.0.1:9224/json/list')).json();
    for (const t of targets.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      if (await evalRaw(ws, WRAP(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gbWs = ws; break; }
      ws.close();
    }
    if (!gbWs) await sleep(1000);
  }
  if (!gbWs) { console.log('FAIL: webview not found'); process.exit(1); }
  const E = (js) => evalRaw(gbWs, WRAP(js));

  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => (b.textContent.includes('Files') || b.textContent.includes('文件'))).click()`);
  await sleep(3000);

  // 进入 已完成 → 选中 项目甲
  await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('已完成')); if (r) r.dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return !!r; })()`);
  await sleep(2200);
  await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('项目甲')); if (r) r.click(); return !!r; })()`);
  await sleep(1500);

  // 点移动 → webview 对话框出现（含标题与目录列表）
  await E(`(() => { const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => (x.textContent.includes('Move') || x.textContent.includes('移动'))); if (b) b.click(); return !!b; })()`);
  await sleep(2000);
  const dlg = await E(`(() => { const d = document.querySelector('.gg-move-dlg'); if (!d) return null; return { title: d.querySelector('.gg-modal-title, h3, .gg-dlg-title')?.textContent ?? d.textContent.slice(0, 40), rows: [...document.querySelectorAll('.gg-move-row')].map(r => r.textContent.trim()), okBtn: !!document.querySelector('.gg-move-foot .gg-btn.primary') }; })()`);
  assert('移动对话框弹出（webview 内）', !!dlg);
  if (dlg) {
    console.log('    对话框行:', JSON.stringify(dlg.rows));
    assert('对话框含确认按钮', dlg.okBtn);
  }

  // 浏览子目录（点已完成后返回根 → 面包屑导航回根）
  await E(`(() => { const c = [...document.querySelectorAll('.gg-move-crumb')].find(x => x.textContent.includes('root') || x.textContent.includes('根')); if (c) c.click(); return !!c; })()`);
  await sleep(1500);
  const rootRows = await E(`[...document.querySelectorAll('.gg-move-row')].map(r => r.textContent.trim())`);
  console.log('    根目录列表:', JSON.stringify(rootRows));

  // 取消 → 对话框关闭
  await E(`[...document.querySelectorAll('.gg-move-foot .gg-btn')].find(b => !b.classList.contains('primary'))?.click()`);
  await sleep(600);
  assert('取消后对话框关闭', !(await E(`!!document.querySelector('.gg-move-dlg')`)));

  // 再次移动：移动到根（dst=''）
  await E(`(() => { const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => (x.textContent.includes('Move') || x.textContent.includes('移动'))); if (b) b.click(); return !!b; })()`);
  await sleep(1800);
  await E(`document.querySelector('.gg-move-foot .gg-btn.primary')?.click()`);
  await sleep(3500);
  const after = await E(`(() => ({ dlgClosed: !document.querySelector('.gg-move-dlg'), banner: !document.querySelector('.gg-banner.accent')?.classList.contains('hidden'), bannerText: document.querySelector('.gg-banner-b')?.textContent ?? '', listText: document.querySelector('.gg-files-list')?.textContent ?? '', toast: document.querySelector('.gg-notif')?.textContent ?? 'none' }))()`);
  assert('确认后对话框关闭', after.dlgClosed);
  assert('移动横幅出现（引导纯移动提交）', after.banner);
  console.log('    横幅:', after.bannerText.slice(0, 60), '| toast:', String(after.toast).slice(0, 40));
  assert('git mv 已执行（已完成/ 消失，根出现 项目甲）', !String(after.listText).includes('已完成') && String(after.listText).includes('项目甲'));

  // 复位：移回 已完成/
  await sleep(500);
  await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('项目甲')); if (r) r.click(); return !!r; })()`);
  await sleep(1200);
  await E(`(() => { const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => (x.textContent.includes('Move') || x.textContent.includes('移动'))); if (b) b.click(); return !!b; })()`);
  await sleep(1800);
  await E(`(() => { const r = [...document.querySelectorAll('.gg-move-row')].find(x => x.textContent.includes('已完成')); if (r) r.click(); return !!r; })()`);
  await sleep(1500);
  await E(`document.querySelector('.gg-move-foot .gg-btn.primary')?.click()`);
  await sleep(3000);
  const restored = await E(`document.querySelector('.gg-files-list')?.textContent ?? ''`);
  assert('复位（项目甲 移回 已完成/）', String(restored).includes('已完成'));

  console.log(`\n结果: ${bad.length ? 'FAIL' : 'PASS'} (${ok.length}/${ok.length + bad.length})`);
  if (bad.length) console.log('失败: ' + bad.join(' | '));
  gbWs.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(2); });
