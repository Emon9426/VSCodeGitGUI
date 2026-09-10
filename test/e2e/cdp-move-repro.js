/**
 * 真机复现：移动按钮链路（问题 3 排查）。
 * 步骤：打开 GitBoard → 文件页 → 选中文件夹 → 点「移动到…」→
 * 轮询 PowerShell 窗口标题检测"选择文件夹"对话框是否弹出 → Esc 取消 → 验证取消后无报错。
 */
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
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

/** 枚举系统顶层窗口标题（检测原生对话框） */
function windowTitles() {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"', { encoding: 'utf8', timeout: 15000 });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench') || p.url().includes('vscode-file')) ?? browser.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(1000);
  await page.keyboard.press('Control+Alt+G');   // gitboard.open 全局键绑定
  await sleep(6000);

  // 连 GitBoard webview
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

  // 文件页 → 选中文件夹（已完成）
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files')).click()`);
  await sleep(3000);
  const clicked = await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('已完成')); if (r) r.click(); return !!r; })()`);
  await sleep(1500);
  console.log('选中文件夹:', clicked);

  // 记录基线窗口 → 点移动按钮 → 轮询检测新窗口（对话框）
  const before = new Set(windowTitles());
  console.log('基线窗口数:', before.size);
  await E(`(() => { const b = [...document.querySelectorAll('.gg-files-cbtn')].find(x => x.textContent.includes('Move')); if (b) b.click(); return !!b; })()`);
  console.log('已点击移动按钮，等待对话框…');
  let dialogTitle = null;
  for (let i = 0; i < 20 && !dialogTitle; i++) {
    await sleep(500);
    for (const t of windowTitles()) {
      if (!before.has(t) && /文件夹|folder|选择|Select|浏览|Browse/i.test(t)) { dialogTitle = t; break; }
    }
  }
  if (dialogTitle) {
    console.log('✓ 原生对话框已弹出:', JSON.stringify(dialogTitle));
  } else {
    const now = windowTitles();
    const news = now.filter(t => !before.has(t));
    console.log('✗ 对话框未检出。新窗口:', JSON.stringify(news.slice(0, 6)));
    // 检查 webview 侧是否有 toast（错误反馈）
    await sleep(1000);
    const toast = await E(`document.querySelector('.gg-notif')?.textContent ?? 'none'`);
    console.log('webview toast:', toast);
  }
  // 关对话框（若有）：对前台窗口发 Esc（SendKeys）
  try { execSync('powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; $w.SendKeys(\'{ESC}\')"', { timeout: 8000 }); } catch { }
  await sleep(1500);
  const toastAfter = await E(`document.querySelector('.gg-notif')?.textContent ?? 'none'`);
  console.log('取消后 toast（应无错误）:', toastAfter);
  gbWs.close();
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(2); });
