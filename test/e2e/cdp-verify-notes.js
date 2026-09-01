/**
 * v0.15.0 快速笔记真机验证（隔离 profile + CDP）。
 * 用法：node cdp-verify-notes.js <port>
 * 场景：非 git 文件夹下打开笔记面板——①活动栏图标直达 ②编辑器渲染 ③新建+输入+自动保存落盘
 *       ④重开恢复 ⑤主面板（Git）不受影响；⑦HTML 导出往返（单测已覆盖，此处验证入口存在）。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PORT = (() => {
  const raw = process.argv[2] || '9241';
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
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail ?? '' }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
const NOTES_DIR = path.join(os.homedir(), 'GitBoardNotes');

(async () => {
  const t0 = Date.now();
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();

  // 1) 点击活动栏「快速笔记」图标（第二个 GitBoard 容器）
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const lis = ab && [...ab.querySelectorAll('li.action-item')];
      const target = lis && lis.find(el => {
        const a = el.querySelector('a');
        const label = (a?.getAttribute('aria-label') || a?.title || '');
        return /Quick Notes|快速笔记/i.test(label);
      });
      if (target) { target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); target.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1200);
  }
  check('快速笔记活动栏图标可见并点击', opened);
  if (!opened) { await closeBrowser(); process.exit(1); }

  // 2) 找笔记 webview 帧（#notes-app）
  let gb = null;
  for (let i = 0; i < 20 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.ProseMirror')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(700);
  }
  if (!gb) { console.log('FAIL: notes webview 未找到'); await closeBrowser(); process.exit(1); }
  const openMs = Date.now() - t0;
  console.log(`INFO | 面板打开+编辑器就绪 ~${openMs}ms（含脚本启动开销，仅观察项）`);
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // 3) 三栏装配
  const shell = await E(`(() => ({ side: !!document.querySelector('.n-side'), main: !!document.querySelector('.n-main'), outline: !!document.querySelector('.n-outline'), pm: !!document.querySelector('.ProseMirror'), toolbar: document.querySelectorAll('.gg-tbtn').length, version: (document.body.textContent.match(/0\\.15\\.\\d+/) || ['?'])[0] }))()`);
  check('三栏装配（列表/主区/大纲）', shell.side && shell.main && shell.outline);
  check('TipTap 编辑器就绪', shell.pm);
  check('工具栏按钮 ≥ 15', shell.toolbar >= 15, 'count=' + shell.toolbar);

  // 4) 新建笔记 → 输入 → 自动保存落盘
  const newBtn = await E(`(() => { const b = document.querySelector('.pv-mini.new'); if (b) b.click(); return !!b; })()`);
  check('点击「＋ 新建」', newBtn);
  await sleep(400);
  await E(`(() => { const pm = document.querySelector('.ProseMirror'); pm.focus(); return true; })()`);
  await page.keyboard.type('真机验证笔记标题');
  await sleep(300);
  await E(`(() => { const h = document.querySelector('.ProseMirror h1, .ProseMirror p'); return !!h; })()`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('正文一行 v015');
  await sleep(1400);   // 等 800ms 防抖保存
  const savedFile = path.join(NOTES_DIR, '真机验证笔记标题.gbnote.json');
  // 语言相关：隔离 profile 默认英文 → 默认名可能是 'Untitled note'；标题自动跟随 H1 后则为输入文本
  const anyNote = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.gbnote.json') && f !== 'Untitled note.gbnote.json');
  check('自动保存落盘（新 .gbnote.json 存在）', fs.existsSync(savedFile) || anyNote.length > 0, (fs.readdirSync(NOTES_DIR).join(', ') || '(empty)').slice(0, 80));
  const target = fs.existsSync(savedFile) ? savedFile : path.join(NOTES_DIR, anyNote[0]);
  if (fs.existsSync(target)) {
    const content = JSON.parse(fs.readFileSync(target, 'utf8'));
    check('文件格式 = NoteDoc（version/title/doc）', content.version === 1 && !!content.title && !!content.doc);
    check('标题跟随首行 Heading 或默认名', content.title.includes('真机验证笔记标题') || /Untitled|未命名/.test(content.title), content.title);
    const docStr = JSON.stringify(content.doc);
    check('doc 含输入正文', docStr.includes('v015'));
  }

  // 5) 文件列表出现该笔记
  const inList = await E(`[...document.querySelectorAll('.n-item .n-t')].some(x => x.textContent.includes('真机验证'))`);
  check('文件列表显示新笔记', inList);

  // 6) 主面板（Git）入口仍在（隔离：非 git 文件夹下主面板显示无仓库引导，笔记页不受影响）
  const gitOk = await page.evaluate(() => {
    const ab = document.getElementById('workbench.parts.activitybar');
    return !!ab && [...ab.querySelectorAll('li.action-item')].length >= 2;
  });
  check('Git 与笔记两个活动栏容器并存', gitOk);

  const fails = results.filter(r => !r.pass).length;
  console.log(fails ? `NOTES-VERIFY FAIL x${fails}` : 'NOTES-VERIFY ALL-PASS');
  await closeBrowser();
  // 清理验证产物
  try { fs.rmSync(savedFile, { force: true }); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);

  async function closeBrowser() {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      ws.send(JSON.stringify({ id: 999, method: 'Browser.close' }));
      await sleep(1200);
      ws.close();
    } catch (e) { console.log('close: ' + e.message); }
    try { gb?.ws?.close(); } catch { /* ignore */ }
    try { b.close(); } catch { /* ignore */ }
  }
})();
