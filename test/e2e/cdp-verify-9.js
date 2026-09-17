/**
 * Issue #9 实机验证：工作副本多选批量操作 + 编辑器保存实时刷新。
 * 前置：fixture %TEMP%/gb9-repo（staged s1 / unstaged u1-u3 / 干净 v.md）。
 * git index/磁盘硬校验由外部脚本在验证后单独执行（本脚本纯 UI 断言）。
 * 用法：node cdp-verify-9.js <port>
 *
 * A1 工作副本初始列表（staged 1 + unstaged 3）
 * A2 Ctrl 点选 u1+u2 → 批量条「已选 2」
 * A3 批量「暂存」→ u1/u2 移入已暂存组
 * A4 quickopen 打开 v.md → 输入 → Ctrl+S → 未暂存组实时出现 v.md（无手动刷新）
 * A5 Esc 清空选择
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9233';
  if (/^\d+$/.test(raw) && +raw >= 2000 && +raw <= 65535) return raw;
  throw new Error('bad port');
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

  for (let i = 0; i < 10; i++) {
    const ok = await page.evaluate(() => {
      const seg = [...document.querySelectorAll('.gg-viewseg button')];
      const w = seg.find(x => /工作副本|Working/i.test(x.textContent || ''));
      if (w) { w.click(); return true; }
      return false;
    }).catch(() => false);
    if (ok) break;
    await sleep(800);
  }

  let gb = null;
  for (let i = 0; i < 25 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-work-outer')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(700);
  }
  if (!gb) { console.log('FAIL | webview 帧未找到'); await b.close(); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // A1：初始列表
  let staged = [], unstaged = [];
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const st = await E(`(() => {
      const boxes = [...document.querySelectorAll('.gg-work-rows')];
      const rowsOf = (box) => [...(box?.querySelectorAll('.gg-work-fpath') ?? [])].map(p => p.title);
      return { staged: rowsOf(boxes[1]), unstaged: rowsOf(boxes[2]) };
    })()`);
    staged = st?.staged ?? [];
    unstaged = st?.unstaged ?? [];
    if (staged.length + unstaged.length >= 4) break;
  }
  check('A1 初始列表：staged s1 + unstaged u1-u3', staged.length === 1 && unstaged.length === 3, `staged=[${staged}] unstaged=[${unstaged}]`);

  // A2：Ctrl 点选 u1+u2 → 批量条
  const clickRow = async (p, ctrl) => {
    await E(`(() => { const r = [...document.querySelectorAll('.gg-work-row')].find(x => x.querySelector('.gg-work-fpath')?.title === ${JSON.stringify(p)}); if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!ctrl} })); return !!r; })()`);
    await sleep(250);
  };
  await clickRow('u1.md', true);
  await clickRow('u2.md', true);
  const bar1 = await E(`(() => { const b = document.querySelector('.gg-work-batchbar'); return b && !b.classList.contains('hidden') ? b.textContent : ''; })()`);
  check('A2 Ctrl 多选 u1+u2 → 批量条出现', /2/.test(bar1 || ''), (bar1 || '').slice(0, 40));

  // A3：批量暂存 → u1/u2 进已暂存组
  await E(`(() => { const b = document.querySelector('.gg-work-batchbar'); const btn = b && [...b.querySelectorAll('button')].find(x => /暂存 2 项|Stage 2/i.test(x.textContent)); if (btn) { btn.click(); return true; } return false; })()`);
  let stagedAfter = [];
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const st = await E(`(() => { const boxes = [...document.querySelectorAll('.gg-work-rows')]; return [...(boxes[1]?.querySelectorAll('.gg-work-fpath') ?? [])].map(p => p.title); })()`);
    stagedAfter = st ?? [];
    if (stagedAfter.length >= 3) break;
  }
  check('A3 批量暂存后 UI 已暂存组含 u1/u2/s1', stagedAfter.includes('u1.md') && stagedAfter.includes('u2.md') && stagedAfter.includes('s1.md'), stagedAfter.join(','));

  // A4：quickopen 打开 v.md → 输入 → Ctrl+S → 实时刷新出现
  await page.keyboard.press('Control+p');
  await sleep(600);
  await page.keyboard.type('v.md', { delay: 40 });
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(1200);
  await page.keyboard.type('saved-from-editor', { delay: 30 });
  await page.keyboard.press('Control+s');
  let vAppeared = false;
  for (let i = 0; i < 12 && !vAppeared; i++) {
    await sleep(500);
    vAppeared = await E(`(() => { const boxes = [...document.querySelectorAll('.gg-work-rows')]; const un = [...(boxes[2]?.querySelectorAll('.gg-work-fpath') ?? [])].map(p => p.title); return un.includes('v.md'); })()`).catch(() => false);
  }
  check('A4 编辑器保存 v.md → 工作副本实时出现（无手动刷新）', vAppeared);

  // A5：清空选择（点批量条 ✕；Esc 路径已由 harness 覆盖——编辑器焦点下 webview 不收键盘是正确行为）
  await clickRow('u3.md', true);
  await clickRow('v.md', true);
  await E(`(() => { const b = document.querySelector('.gg-work-batchbar'); const btn = b && [...b.querySelectorAll('.gg-icon-btn')].find(x => b.contains(x)); if (btn) btn.click(); return !!btn; })()`);
  await sleep(300);
  const barHidden = await E(`(() => { const b = document.querySelector('.gg-work-batchbar'); return !b || b.classList.contains('hidden'); })()`);
  check('A5 清空多选（批量条收起）', !!barHidden);

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
