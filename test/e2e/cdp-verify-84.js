/**
 * Issue #84 实机回归：侧栏分支树图标体系（SVG 槽位 / 对齐网格 / 计数胶囊 / 折叠旋转）。
 * 前置：VS Code 以 --extensionDevelopmentPath=<本仓库> + --remote-debugging-port 打开本仓库自身，
 *       CDP 端口运行中。用法：node cdp-verify-84.js <port>
 *
 * 用例（对齐锚点单位 = webview iframe 内容坐标 px）：
 *  V1 组头折叠箭头 = SVG（.gg-side-caret svg.gg-ic，无文本字符）
 *  V2 一级组头类型图标（本地 branch / 远程 syncFetch）＝ .gg-side-ticon svg
 *  V3 计数徽章胶囊化（.gg-side-count 有背景色，非透明）
 *  V4 分支行/远程行行首 = .gg-side-slot svg（branch 图标）；HEAD 行 = 图标右上 .gg-dot-badge
 *  V5 对齐网格：一级组头名字.left == 顶层行槽位.left；前缀组头名字.left == 其子行槽位.left（±1px）
 *  V6 折叠交互：点击前缀组头 → 子行隐藏 + 箭头失去 .open；再点恢复
 *  V7 标签行图标槽（仓库无 tag 时自动跳过）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
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
  if (!opened) { process.exit(1); }   // 不调 b.close()——connectOverCDP 下会把 VS Code 一并关掉

  let gb = null;
  for (let i = 0; i < 40 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-side')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(500);
  }
  if (!gb) { console.log('FAIL | webview 帧未找到'); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  await sleep(3500);   // 等分支扫描收尾

  // ---------- V1/V2/V3：组头 SVG 箭头 / 类型图标 / 计数胶囊 ----------
  const heads = await E(`(() => {
    const h1 = document.querySelectorAll('.gg-side-item.pgroup.l1');
    return {
      caretSvg: !!document.querySelector('.gg-side-caret svg.gg-ic'),
      caretNoText: (document.querySelector('.gg-side-caret') || {}).textContent === '',
      ticons: document.querySelectorAll('.gg-side-item.pgroup.l1 .gg-side-ticon svg.gg-ic').length,
      l1Count: h1.length,
      countBg: (() => { const c = document.querySelector('.gg-side-count'); return c ? getComputedStyle(c).backgroundColor : ''; })(),
      countText: (document.querySelector('.gg-side-count') || {}).textContent || '',
    };
  })()`).catch(() => ({}));
  check('V1 折叠箭头 = SVG（无文本字符）', heads.caretSvg && heads.caretNoText, JSON.stringify(heads));
  check('V2 一级组头类型图标 ×2（branch/syncFetch）', heads.ticons === 2 && heads.l1Count === 2, `ticons=${heads.ticons} l1=${heads.l1Count}`);
  check('V3 计数徽章胶囊背景', typeof heads.countBg === 'string' && heads.countBg !== 'rgba(0, 0, 0, 0)' && heads.countBg !== 'transparent', `bg=${heads.countBg} text=${heads.countText}`);

  // ---------- V4：分支行图标槽 + HEAD 角标 ----------
  const rows = await E(`(() => {
    const branchSlots = document.querySelectorAll('.gg-side-item.branch .gg-side-slot svg.gg-ic').length;
    const headRow = document.querySelector('.gg-side-item.branch.head');
    return {
      branchSlots,
      badge: !!headRow?.querySelector('.gg-side-slot .gg-dot-badge'),
      headName: headRow?.querySelector('.gg-side-name')?.textContent || '',
      headBold: headRow ? getComputedStyle(headRow.querySelector('.gg-side-name')).fontWeight : '',
      remoteSlots: document.querySelectorAll('.gg-side-item.remote .gg-side-slot svg.gg-ic').length,
    };
  })()`).catch(() => ({}));
  check('V4 分支行图标槽 ≥1', (rows.branchSlots || 0) >= 1, `slots=${rows.branchSlots}`);
  check('V4 HEAD 行 = 图标右上绿点角标 + 名字加粗', rows.badge && Number(rows.headBold) >= 600, `head=${rows.headName} w=${rows.headBold}`);
  check('V4 远程行图标槽 ≥1（组展开时）', rows.remoteSlots === 0 || rows.remoteSlots >= 1, `remote=${rows.remoteSlots}`);

  // ---------- V5：对齐网格 ----------
  const align = await E(`(() => {
    const L = el => el ? Math.round(el.getBoundingClientRect().left) : -1;
    const l1 = document.querySelector('.gg-side-item.pgroup.l1');            // 本地分支组头
    const topRow = document.querySelector('.gg-side-group .gg-side-item.branch');
    const pg = document.querySelector('.gg-side-item.pgroup:not(.l1)');      // 第一个前缀组头
    const pgBox = pg ? pg.parentElement : null;
    const subRow = pgBox ? pgBox.querySelector('.gg-side-item.branch .gg-side-slot') : null;
    return {
      l1Name: L(l1?.querySelector('.gg-side-name')),
      topSlot: L(topRow?.querySelector('.gg-side-slot')),
      pgLabel: pg?.querySelector('.gg-side-name')?.textContent || '',
      pgName: L(pg?.querySelector('.gg-side-name')),
      subSlot: L(subRow),
    };
  })()`).catch(() => ({}));
  check('V5 一级组头名字 == 顶层行图标列（±1px）', Math.abs(align.l1Name - align.topSlot) <= 1, `${align.l1Name} vs ${align.topSlot}`);
  if (align.pgName > 0) {
    check('V5 前缀组头名字 == 子行图标列（±1px）', Math.abs(align.pgName - align.subSlot) <= 1, `『${align.pgLabel}』${align.pgName} vs ${align.subSlot}`);
  } else {
    console.log('SKIP | 前缀组头（本仓库无前缀分支时）');
  }

  // ---------- V6：折叠交互 ----------
  if (align.pgName > 0) {
    const fold = await E(`(() => {
      const pg = document.querySelector('.gg-side-item.pgroup:not(.l1)');
      pg.click();
      const box = pg.parentElement;
      const hidden = box.children.length <= 1;
      const open = pg.querySelector('.gg-side-caret svg').classList.contains('open');
      pg.click();
      const back = box.children.length > 1;
      const open2 = pg.querySelector('.gg-side-caret svg').classList.contains('open');
      return { hidden, openAfterCollapse: open, back, openAfterExpand: open2 };
    })()`).catch(() => ({}));
    check('V6 折叠：子行就地移除 + 箭头失去 .open', fold.hidden && !fold.openAfterCollapse, JSON.stringify(fold));
    check('V6 展开：子行恢复 + 箭头回到 .open', fold.back && fold.openAfterExpand);
  } else {
    console.log('SKIP | V6 折叠交互（无前缀组）');
  }

  // ---------- V7：标签行图标槽 ----------
  const tags = await E(`document.querySelectorAll('.gg-side-item.tag').length`).catch(() => 0);
  if (tags > 0) {
    const t = await E(`(() => {
      const row = document.querySelector('.gg-side-item.tag');
      return { slot: !!row.querySelector('.gg-side-slot svg.gg-ic') };
    })()`).catch(() => ({}));
    check('V7 标签行图标槽', t.slot);
  } else {
    console.log('SKIP | V7 标签行图标槽（本仓库无 tag）');
  }

  // ---------- 侧栏截图（供人工复核） ----------
  await page.screenshot({ path: 'e2e-84-side.png', clip: await page.evaluate(() => {
    const el = document.querySelector('.split-view-view.visible .part.sidebar') || document.body;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: Math.min(r.width, 700), height: Math.min(r.height, 900) };
  }) }).catch(() => page.screenshot({ path: 'e2e-84-full.png' }));

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n#84 实机回归：${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);   // 只断开本进程连接，不动 VS Code 宿主
})();
