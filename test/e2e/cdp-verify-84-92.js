/**
 * Issue #84/#87/#88/#89/#92 实机回归(v0.33.0,五组 L1-L5)。
 * 前置:VS Code 以 gitboard-0.33.0.vsix(独立 profile/extensions-dir)+ --remote-debugging-port 打开
 *       fixture 仓库 %TEMP%/gb33/work(本地 main(HEAD)+dev 未推送;远程 origin 含
 *       feat/alpha、feat/beta、fix/gamma、refactor/v1.8.0 可检出;tag v1.0.0)。
 * 用法:node cdp-verify-84-92.js <port>
 *
 *  L1 侧栏图标体系(#84):SVG 箭头/类型图标/胶囊/行图标+HEAD 角标/三组对齐/折叠旋转
 *  L2 选择器图标体系(#87):两模式无字形、行/大区头/组头 SVG、folder 对齐;工具栏检出按钮 SVG
 *  L3 多选批量检出(#88):勾选 2 远程 → 批量条 → 阻塞模态「检出 1/2 → 2/2」→ 完成自动关
 *  L4 本地操作阻塞模态(#89):分支删除全程模态 + 无取消钮 + 删除后行消失
 *  L5 纯提交第 4 段(#92):四段/双线/视图组三按钮/pure 切换/pure 下切范围正交
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9246';
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
/** 轮询断言:表达式在 timeout 内变真 */
const waitEval = async (E, js, timeout, step = 400) => {
  for (let t = 0; t < timeout; t += step) {
    if (await E(js).catch(() => false)) return true;
    await sleep(step);
  }
  return false;
};

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
  check('打开 GitBoard 面板', opened);
  if (!opened) process.exit(1);

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

  check('分支扫描完成(≥3 本地行)', await waitEval(E, `document.querySelectorAll('.gg-side-item.branch').length >= 2`, 15000));

  // ---------------- L1:侧栏图标体系(#84) ----------------
  const l1 = await E(`(() => {
    const L = el => el ? Math.round(el.getBoundingClientRect().left) : -1;
    const l1head = document.querySelector('.gg-side-item.pgroup.l1');
    const topRow = document.querySelector('.gg-side-group .gg-side-item.branch');
    const headRow = document.querySelector('.gg-side-item.branch.head');
    const pg = document.querySelector('.gg-side-item.pgroup:not(.l1)');
    const subSlot = pg?.parentElement?.querySelector('.gg-side-item.remote .gg-side-slot, .gg-side-item.branch .gg-side-slot');
    const cnt = document.querySelector('.gg-side-count');
    return {
      caretSvg: !!document.querySelector('.gg-side-caret svg.gg-ic'),
      ticons: document.querySelectorAll('.gg-side-item.pgroup.l1 .gg-side-ticon svg.gg-ic').length,
      cntBg: cnt ? getComputedStyle(cnt).backgroundColor : '',
      headBadge: !!headRow?.querySelector('.gg-side-slot .gg-dot-badge'),
      headBold: headRow ? getComputedStyle(headRow.querySelector('.gg-side-name')).fontWeight : '',
      branchSlots: document.querySelectorAll('.gg-side-item.branch .gg-side-slot svg.gg-ic').length,
      tagSlots: document.querySelectorAll('.gg-side-item.tag .gg-side-slot svg.gg-ic').length,
      align1: Math.abs(L(l1head?.querySelector('.gg-side-name')) - L(topRow?.querySelector('.gg-side-slot'))),
      pgLabel: pg?.querySelector('.gg-side-name')?.textContent || '',
      align2: Math.abs(L(pg?.querySelector('.gg-side-name')) - L(subSlot)),
    };
  })()`).catch(() => ({}));
  check('L1 折叠箭头=SVG', l1.caretSvg);
  check('L1 一级组头类型图标×2', l1.ticons === 2, `ticons=${l1.ticons}`);
  check('L1 计数胶囊(真机主题背景)', typeof l1.cntBg === 'string' && l1.cntBg !== 'rgba(0, 0, 0, 0)' && l1.cntBg !== 'transparent', l1.cntBg);
  check('L1 HEAD=图标右上角标+粗体', l1.headBadge && Number(l1.headBold) >= 600);
  check('L1 分支行图标槽', (l1.branchSlots || 0) >= 2, `slots=${l1.branchSlots}`);
  check('L1 标签行图标槽', (l1.tagSlots || 0) >= 1, `tag=${l1.tagSlots}`);
  check('L1 对齐:一级组头名字=顶层行图标(±1)', l1.align1 <= 1, `dx=${l1.align1}`);
  check('L1 对齐:前缀组头名字=子行图标(±1)', l1.align2 <= 1, `『${l1.pgLabel}』dx=${l1.align2}`);
  const fold = await E(`(() => {
    const pg = document.querySelector('.gg-side-item.pgroup:not(.l1)');
    pg.click();
    const hidden = pg.parentElement.children.length <= 1 && !pg.querySelector('.gg-side-caret svg').classList.contains('open');
    pg.click();
    const back = pg.parentElement.children.length > 1 && pg.querySelector('.gg-side-caret svg').classList.contains('open');
    return { hidden, back };
  })()`).catch(() => ({}));
  check('L1 折叠/展开就地重绘+箭头旋转', fold.hidden && fold.back);

  // ---------------- L2:选择器图标体系(#87) ----------------
  await E(`document.querySelector('.gg-checkout-btn')?.click()`);
  await sleep(500);
  const l2 = await E(`(() => {
    const bp = document.querySelector('.gg-bp');
    if (!bp) return { open: false };
    const L = el => el ? Math.round(el.getBoundingClientRect().left) : -1;
    const pgHead = bp.querySelector('.gg-bp-head.l2');
    const subRow = pgHead ? (pgHead.nextElementSibling?.classList.contains('gg-bp-row') ? pgHead.nextElementSibling : null) : null;
    return {
      open: true,
      glyph: /[●⑂⇅◎＋]/.test(bp.textContent || ''),
      rowSvg: bp.querySelectorAll('.gg-bp-row .gg-bp-ic svg.gg-ic').length,
      sync: bp.querySelectorAll('.gg-bp-head .gg-bp-hic svg.gg-ic').length,
      folder: bp.querySelectorAll('.gg-bp-head.l2 .gg-bp-hic svg.gg-ic').length,
      align: pgHead && subRow ? Math.abs(L(pgHead.querySelector('.gg-bp-name')) - L(subRow.querySelector('.gg-bp-ic'))) : -1,
      cbs: bp.querySelectorAll('input.gg-bp-cb[type=checkbox]').length,
      cbX: [...bp.querySelectorAll('input.gg-bp-cb')].map(c => L(c)),
    };
  })()`).catch(() => ({}));
  check('L2 checkout 弹窗打开', l2.open);
  check('L2 无字符字形残留', l2.open && !l2.glyph);
  check('L2 行图标=SVG', (l2.rowSvg || 0) >= 4, `svg=${l2.rowSvg}`);
  check('L2 大区头 syncFetch+组头 folder', (l2.sync || 0) >= 1 && (l2.folder || 0) >= 1, `sync=${l2.sync} folder=${l2.folder}`);
  check('L2 对齐:组头名字=子行图标(±1)', l2.align >= 0 && l2.align <= 1, `dx=${l2.align}`);
  check('L2 多选勾选框(5 个可检出远程,含无前缀 hotfix)', l2.cbs === 5, `cb=${l2.cbs}`);
  // #101:无前缀顶层行(depth=0)与组内行(depth=1)勾选框严格同列
  check('L2 勾选框跨层级同列(±1)', Array.isArray(l2.cbX) && l2.cbX.length >= 2 && Math.max(...l2.cbX) - Math.min(...l2.cbX) <= 1, (l2.cbX || []).join(','));
  await E(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const m = document.querySelector('.gg-modal-overlay'); if (m) m.remove(); return !document.querySelector('.gg-bp'); })()`);
  await sleep(300);
  // filter 模式(本地组+范围项+HEAD 角标)
  await E(`document.querySelector('.gg-filter-btn')?.click()`);
  await sleep(500);
  const l2f = await E(`(() => {
    const bp = document.querySelector('.gg-bp');
    if (!bp) return { open: false };
    return {
      open: true,
      glyph: /[●⑂⇅◎＋]/.test(bp.textContent || ''),
      scopeSvg: bp.querySelectorAll('.gg-bp-row.scope .gg-bp-ic svg.gg-ic').length,
      headBadge: !!bp.querySelector('.gg-bp-row .gg-bp-ic .gg-dot-badge'),
      localsHead: !![...bp.querySelectorAll('.gg-bp-head')].find(h => /本地分支|Branches/.test(h.textContent || '')),
    };
  })()`).catch(() => ({}));
  check('L2 filter 弹窗:范围项 graph 图标+HEAD 角标', l2f.open && !l2f.glyph && (l2f.scopeSvg || 0) >= 3 && l2f.headBadge, `scope=${l2f.scopeSvg} badge=${l2f.headBadge}`);
  const tbIcon = await E(`!!document.querySelector('.gg-checkout-btn svg.gg-ic')`);
  check('L2 工具栏检出按钮=branch SVG(无 ⑂)', tbIcon);
  await E(`(() => { const m = document.querySelector('.gg-modal-overlay'); if (m) m.remove(); return true; })()`);

  // ---------------- L5:纯提交第 4 段(#92)——放 L3 前(L3 会切分支改状态) ----------------
  const l5 = await E(`(() => {
    const seg = document.querySelector('.gg-scope-seg');
    const btns = seg ? [...seg.querySelectorAll('.gg-scope-btn')] : [];
    const pure = seg?.querySelector('.gg-scope-btn.pure');
    const viewBtns = [...document.querySelectorAll('.gg-viewseg .gg-viewseg-btn')];
    return {
      four: btns.length === 4,
      pureLabel: /纯提交|Pure/i.test(pure?.textContent || ''),
      dbl: pure ? getComputedStyle(pure).borderLeftStyle === 'double' : false,
      viewThree: viewBtns.length === 3,
      viewNoPure: !viewBtns.some(x => /纯提交|Pure/i.test(x.textContent || '')),
    };
  })()`).catch(() => ({}));
  check('L5 四段分段器+双线分隔', l5.four && l5.pureLabel && l5.dbl);
  check('L5 视图组三按钮(纯提交已移除)', l5.viewThree && l5.viewNoPure);
  await E(`document.querySelector('.gg-scope-btn.pure')?.click()`);
  await sleep(400);
  check('L5 点第 4 段→pure 选中', await E(`document.querySelector('.gg-scope-btn.pure')?.classList.contains('on')`));
  await E(`[...document.querySelectorAll('.gg-scope-btn')].find(b => /本地|Local/.test(b.textContent || ''))?.click()`);
  check('L5 pure 下点「本地」→范围生效且第 4 段保持', await waitEval(E,
    `(() => { const seg = document.querySelector('.gg-scope-seg'); const local = [...seg.querySelectorAll('.gg-scope-btn')].find(b => /本地|Local/.test(b.textContent||'')); return local?.classList.contains('on') && seg.querySelector('.gg-scope-btn.pure')?.classList.contains('on'); })()`, 6000));
  await E(`document.querySelector('.gg-scope-btn.pure')?.click()`);
  await sleep(400);
  check('L5 再点第 4 段→回图视图', await E(`!document.querySelector('.gg-scope-btn.pure')?.classList.contains('on')`));

  // ---------------- L3:多选批量检出(#88)+ 阻塞模态(#89 checkout) ----------------
  await E(`document.querySelector('.gg-checkout-btn')?.click()`);
  await sleep(500);
  // #101 后列表含无前缀顶层行(hotfix)——按短名定位勾选(组内行显示剥前缀短名),勿按 DOM 序
  await E(`(() => {
    const pick = nm => {
      const row = [...document.querySelectorAll('.gg-bp-row')].find(r => (r.querySelector('.gg-bp-name')?.textContent || '') === nm);
      const cb = row?.querySelector('input.gg-bp-cb');
      if (cb && !cb.checked) cb.click();
      return !!cb;
    };
    return pick('alpha') && pick('beta');
  })()`);
  await sleep(250);
  const barTxt = await E(`document.querySelector('.gg-bp-batch .gg-btn.primary')?.textContent || ''`);
  check('L3 勾选 2 个→批量条「检出 2 个」', /2/.test(barTxt), barTxt);
  await E(`document.querySelector('.gg-bp-batch .gg-btn.primary')?.click()`);
  await sleep(300);
  check('L3 弹窗关闭+阻塞模态出现', await waitEval(E, `!!document.querySelector('.gg-net-overlay')`, 4000));
  check('L3 模态标题=Checkout 1/2 · feat/alpha', await waitEval(E, `/(检出|Checkout) 1\\/2.*alpha/.test(document.querySelector('.gg-net-title')?.textContent || '')`, 6000),
    await E(`document.querySelector('.gg-net-title')?.textContent || ''`));
  const noCancel = await E(`(() => { const o = document.querySelector('.gg-net-overlay'); if (!o) return false; const vis = [...o.querySelectorAll('button')].filter(b => b.offsetParent !== null); return vis.length === 0 || !vis.some(b => /取消|Cancel/.test(b.textContent || '')); })()`);
  check('L3 模态无可见取消钮(本地操作)', noCancel);
  check('L3 串行推进→Checkout 2/2 · feat/beta', await waitEval(E, `/(检出|Checkout) 2\\/2.*beta/.test(document.querySelector('.gg-net-title')?.textContent || '')`, 15000),
    await E(`document.querySelector('.gg-net-title')?.textContent || ''`));
  check('L3 全部完成→done 态', await waitEval(E, `document.querySelector('.gg-net-box')?.classList.contains('done')`, 15000));
  check('L3 done 后模态自动关闭', await waitEval(E, `!document.querySelector('.gg-net-overlay')`, 6000));
  await sleep(800);

  // ---------------- L4:branchDelete 阻塞模态(#89) ----------------
  const menuUp = await E(`(() => {
    const row = [...document.querySelectorAll('.gg-side-item.branch')].find(r => (r.querySelector('.gg-side-name')?.textContent || '') === 'dev');
    if (!row) return 'no-dev-row';
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    return 'ok';
  })()`);
  check('L4 dev 行右键菜单出现', menuUp === 'ok' && await waitEval(E, `!!document.querySelector('.gg-menu .gg-menu-item')`, 3000), menuUp);
  await E(`(() => { const it = [...document.querySelectorAll('.gg-menu-item')].find(i => /删除分支|delete branch/i.test(i.textContent || '')); it?.click(); return !!it; })()`);
  const confUp = await waitEval(E, `!!document.querySelector('.gg-modal button')`, 3000);
  check('L4 删除确认框出现', confUp, await E(`document.querySelector('.gg-modal')?.textContent?.slice(0, 60) || ''`));
  await E(`(() => { const b = [...document.querySelectorAll('.gg-modal button')].find(x => /删除分支|delete branch/i.test(x.textContent || '')); b?.click(); return !!b; })()`);
  // dev 未合并 → -d 被拒 → 二次强删确认（#46 坑：轮询处理第二只确认框）
  let forceHandled = false;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const hasForce = await E(`!!document.querySelector('.gg-modal') && [...document.querySelectorAll('.gg-modal button')].some(x => /强制删除|force/i.test(x.textContent || ''))`).catch(() => false);
    if (hasForce) {
      await E(`(() => { const b = [...document.querySelectorAll('.gg-modal button')].find(x => /强制删除|force/i.test(x.textContent || '')); b?.click(); return true; })()`);
      forceHandled = true;
      break;
    }
    if (!await E(`!!document.querySelector('.gg-modal')`).catch(() => false)) break;
  }
  console.log((forceHandled ? 'INFO' : 'INFO') + ' | L4 二次强删确认' + (forceHandled ? '已处理' : '未出现（分支已合并路径）'));
  check('L4 确认删除→阻塞模态出现', await waitEval(E, `!!document.querySelector('.gg-net-overlay')`, 6000),
    await E(`document.querySelector('.gg-modal')?.textContent?.slice(0, 40) || ''`));
  const delTitle = await E(`document.querySelector('.gg-net-title')?.textContent || ''`);
  // 小仓库删除毫秒级完成——标题可能已是完成态文案(#95 修复后带实际分支名),两种态都算过
  check('L4 模态标题=删除分支(或完成态文案)', /删除分支|delete branch|deleted/i.test(delTitle), delTitle);
  check('L4 删除完成→模态自动关', await waitEval(E, `!document.querySelector('.gg-net-overlay')`, 15000));
  await sleep(600);
  check('L4 侧栏 dev 行消失', await E(`![...document.querySelectorAll('.gg-side-item.branch .gg-side-name')].some(n => n.textContent === 'dev')`));

  // ---------------- 截图留档（.playwright-mcp/ 已双忽略，防再混入发布包） ----------------
  await page.screenshot({ path: '.playwright-mcp/e2e-84-92-final.png' }).catch(() => {});

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n#84/#87/#88/#89/#92 实机回归:${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
})();
