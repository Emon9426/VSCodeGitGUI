/**
 * 实机 CDP 验证（#45/#46 审查轮，2026-09-12；node test/e2e/cdp-verify-review.js）。
 * 结构：workbench(page) → webview host(type=iframe target, raw ws) → #active-frame.contentDocument(内容)。
 * 断言：①徽标 title/剪裁 ②+N 标签悬停清单 ③fetch 阻塞弹窗收口 ④侧栏折叠就地切换
 * ⑤深前缀组缩进 ⑥检出选择器只列可检出分支 ⑦删除分支链路 ⑧通知层级 1300。
 * 前提：%TEMP%/gb-review-setup.sh（夹具仓库 + CDP 9333，全新 profile 语言=en）。通过=REVIEW-ALL-PASS。
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
/** 内容文档作用域包装（TDZ：取帧须用 globalThis.document）。js 为表达式或 IIFE */
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
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('vscode-file')) ?? browser.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(800);

  let ws = await connectGb(9333);
  if (!ws) {
    // 面板未开：点活动栏 GitBoard 图标（aria-label 定位，title 空）
    await page.evaluate(() => {
      const el = [...globalThis.document.querySelectorAll('.activitybar .action-label')]
        .find(x => x.getAttribute('aria-label') === 'GitBoard');
      if (el) el.click();
    });
    await sleep(8000);
    ws = await connectGb(9333);
  }
  if (!ws) { console.log('NO-WEBVIEW-TARGET'); process.exit(1); }
  await sleep(6000);   // 等首屏 repoState 稳定

  const R = [];
  const ok = (name, cond, extra) => R.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);

  // ---- ①② 徽标 title / +N 悬停清单 / 剪裁几何 / subject title ----
  const chips = await ev(ws, `(() => {
    const out = { moreTitle: null, titledChips: 0, chipN: 0, clipped: 0, subjectTitleOk: 0, subjectN: 0 };
    for (const chip of document.querySelectorAll('.gg-chip')) {
      out.chipN++;
      if (chip.title) out.titledChips++;
      if (chip.classList.contains('more')) out.moreTitle = chip.title || null;
    }
    for (const row of document.querySelectorAll('.gg-row')) {
      const msg = row.querySelector('.gg-cell.msg'); if (!msg) continue;
      const sub = row.querySelector('.gg-subject');
      if (sub) { out.subjectN++; if (sub.title === sub.textContent) out.subjectTitleOk++; }
      const mr = msg.getBoundingClientRect();
      for (const chip of msg.querySelectorAll('.gg-chip')) {
        if (chip.classList.contains('current')) continue;   // HEAD 恒醒目不缩，允许右缘贴齐
        const cr = chip.getBoundingClientRect();
        if (cr.width > 0 && cr.right > mr.right + 1.5) out.clipped++;
      }
    }
    return out;
  })()`);
  ok('chip titles present', chips && chips.titledChips > 0, `chipN=${chips && chips.chipN} titled=${chips && chips.titledChips}`);
  ok('+N chip lists remaining tags', !!chips && !!chips.moreTitle && chips.moreTitle.split('\n').length === 2, chips && String(chips.moreTitle).replace(/\n/g, ','));
  ok('no hard-clipped chips', chips && chips.clipped === 0, `clipped=${chips && chips.clipped}`);
  ok('subject title = text', chips && chips.subjectN > 0 && chips.subjectTitleOk === chips.subjectN, `${chips && chips.subjectTitleOk}/${chips && chips.subjectN}`);
  const headTitle = await ev(ws, `(() => { const h = document.querySelector('.gg-chip.head.current'); return h ? h.title : null; })()`);
  ok('HEAD chip title = branch', headTitle === 'main', String(headTitle));

  // ---- ③ fetch 阻塞弹窗：出现 → 成功收口自动关闭 → 无 error 常驻通知 ----
  await ev(ws, `document.querySelector('.gg-tb-btn[data-kind="fetch"]').click(), true`);
  let modalSeen = false;
  for (let i = 0; i < 30 && !modalSeen; i++) {
    modalSeen = await ev(ws, `!!document.querySelector('.gg-net-overlay')`);
    if (!modalSeen) await sleep(100);
  }
  ok('netModal opens on fetch', modalSeen);
  let modalClosed = false;
  for (let i = 0; i < 100 && !modalClosed; i++) {
    modalClosed = !(await ev(ws, `!!document.querySelector('.gg-net-overlay')`));
    if (!modalClosed) await sleep(100);
  }
  ok('netModal auto-closes on success', modalClosed);
  const errNotifs = await ev(ws, `document.querySelectorAll('.gg-notif.error').length`);
  ok('no error notification after fetch', errNotifs === 0, `errNotifs=${errNotifs}`);
  const znotifs = await ev(ws, `getComputedStyle(document.querySelector('.gg-notifs')).zIndex`);
  ok('notifs z-index 1300 (above netModal)', znotifs === '1300', String(znotifs));

  // ---- ⑤ 深前缀组缩进（release/1.0/x 行 depth2=60px；平铺行 28px；子组头 42px） ----
  const indents = await ev(ws, `(() => {
    const out = {};
    for (const it of document.querySelectorAll('.gg-side-item.branch')) {
      const nm = it.querySelector('.gg-side-name'); if (!nm) continue;
      if (nm.textContent === 'x') out.deepRow = getComputedStyle(it).paddingLeft;
      if (nm.textContent === 'main') out.flatRow = getComputedStyle(it).paddingLeft;
      if (nm.textContent === 'login') out.depth1Row = getComputedStyle(it).paddingLeft;
    }
    for (const h of document.querySelectorAll('.gg-side-item.pgroup')) {
      const nm = h.querySelector('.gg-side-name'); if (!nm) continue;
      if (nm.textContent.startsWith('1.0')) out.subGroupHead = getComputedStyle(h).paddingLeft;
    }
    return out;
  })()`);
  ok('deep prefix row indent 60px', indents && parseInt(indents.deepRow, 10) === 60, JSON.stringify(indents));
  ok('flat branch row indent 28px', indents && parseInt(indents.flatRow, 10) === 28, `flat=${indents && indents.flatRow}`);
  ok('depth1 prefix row indent 44px', indents && parseInt(indents.depth1Row, 10) === 44, `d1=${indents && indents.depth1Row}`);
  ok('sub group head indent 42px', indents && parseInt(indents.subGroupHead, 10) === 42, `head=${indents && indents.subGroupHead}`);

  // ---- ④ 侧栏折叠就地切换 ----
  const collapse = await ev(ws, `(() => {
    const head = document.querySelector('.gg-side-item.pgroup.l1');
    const before = head.querySelector('.gg-side-caret').textContent;
    const rowsBefore = head.parentElement.querySelectorAll('.gg-side-item.branch').length;
    head.click();
    const after = head.querySelector('.gg-side-caret').textContent;
    const rowsAfter = head.parentElement.querySelectorAll('.gg-side-item.branch').length;
    head.click();
    const restored = head.parentElement.querySelectorAll('.gg-side-item.branch').length;
    return { before, after, rowsBefore, rowsAfter, restored };
  })()`);
  ok('sidebar collapse toggles in place', collapse && collapse.before === '▾' && collapse.after === '▸'
    && collapse.rowsAfter < collapse.rowsBefore && collapse.restored === collapse.rowsBefore, JSON.stringify(collapse));

  // ---- ⑥ 检出选择器只列可检出分支 ----
  await ev(ws, `(() => { const add = [...document.querySelectorAll('.gg-side-add')].find(x => (x.title || '').includes('branch')); if (add) add.click(); return !!add; })()`);
  let pickerOpen = false;
  for (let i = 0; i < 20 && !pickerOpen; i++) {
    pickerOpen = await ev(ws, `!!document.querySelector('.gg-bp')`);
    if (!pickerOpen) await sleep(200);
  }
  ok('checkout picker opens', pickerOpen);
  const picker = await ev(ws, `(() => {
    const names = [...document.querySelectorAll('.gg-bp-row .gg-bp-name')].map(x => x.textContent);
    return {
      hasRemoteOnly: names.some(n => n.includes('remote-only-branch')),
      hasLocalBranch: names.some(n => n === 'main' || n === 'feature/login' || n === 'wip-unmerged'),
      hasCreate: [...document.querySelectorAll('.gg-bp-row')].some(x => x.classList.contains('create')),
      names,
    };
  })()`);
  ok('picker lists remote-only branch', picker && picker.hasRemoteOnly);
  ok('picker hides local branches', picker && !picker.hasLocalBranch, picker && JSON.stringify(picker.names));
  ok('picker keeps create row', picker && picker.hasCreate);
  await ev(ws, `(() => { const ov = document.querySelector('.gg-bp') && document.querySelector('.gg-bp').closest('.gg-modal-overlay'); if (ov) ov.remove(); return true; })()`);

  // ---- ⑦ 删除分支（wip-unmerged 有上游 → -d 安全删除成功，远端不动） ----
  await ev(ws, `(() => {
    const rows = [...document.querySelectorAll('.gg-side-item.branch')];
    const row = rows.find(x => x.title.startsWith('wip-unmerged'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }));
    return true;
  })()`);
  let menuClicked = false;
  for (let i = 0; i < 10 && !menuClicked; i++) {
    menuClicked = await ev(ws, `(() => {
      const items = [...document.querySelectorAll('.gg-menu-item')];
      const it = items.find(x => x.textContent.includes('Delete Branch') && !x.classList.contains('disabled'));
      if (!it) return false;
      it.click(); return true;
    })()`);
    if (!menuClicked) await sleep(200);
  }
  ok('delete-branch menu item clicked', menuClicked);
  let confirmed = false;
  for (let i = 0; i < 10 && !confirmed; i++) {
    confirmed = await ev(ws, `(() => {
      const btns = [...document.querySelectorAll('.gg-modal-btns .gg-btn')];
      const danger = btns.find(x => x.classList.contains('danger'));
      if (!danger) return false;
      danger.click(); return true;
    })()`);
    if (!confirmed) await sleep(200);
  }
  ok('delete confirm dialog accepted', confirmed);
  // 未合并分支：-d 被拒 → 前端弹「Force Delete」二次确认——轮询点 danger 直到无模态。
  // 坑：二次框在 branch.delete RPC 返回后才弹，须先等它出现，不能立即判空退出
  await sleep(1000);
  let forceFlowDone = false;
  for (let i = 0; i < 15; i++) {
    const any = await ev(ws, `!!document.querySelector('.gg-modal-btns .gg-btn.danger')`);
    if (!any) { forceFlowDone = true; break; }
    await ev(ws, `(() => { const d = document.querySelector('.gg-modal-btns .gg-btn.danger'); if (d) d.click(); return true; })()`);
    await sleep(500);
  }
  ok('unmerged branch force-confirm handled', forceFlowDone);
  // 状态条完成态显示真实分支名（0.8s 窗口，轮询抓取）
  let doneName = '';
  for (let i = 0; i < 20 && !doneName; i++) {
    const t = await ev(ws, `(() => { const n = document.querySelector('.gg-opstatus:not(.off) .gg-opstatus-name'); return n ? n.textContent : ''; })()`);
    if (t && t.includes('wip-unmerged')) doneName = t;
    else await sleep(100);
  }
  ok('opstatus shows real branch name (no {name})', !!doneName, doneName || '(missed flash window)');
  let branchGone = false;
  for (let i = 0; i < 20 && !branchGone; i++) {
    branchGone = !(await ev(ws, `[...document.querySelectorAll('.gg-side-item.branch .gg-side-name')].some(x => x.textContent === 'wip-unmerged')`));
    if (!branchGone) await sleep(300);
  }
  ok('branch removed from sidebar', branchGone);
  const remoteStill = await ev(ws, `[...document.querySelectorAll('.gg-side-item.remote .gg-side-name')].some(x => x.textContent === 'wip-unmerged')`);
  ok('remote branch untouched after local delete', remoteStill === true);

  // ---- 汇总 ----
  const fails = R.filter(x => x.startsWith('FAIL'));
  for (const r of R) console.log(r);
  console.log(fails.length ? `REVIEW-FAIL x${fails.length}` : 'REVIEW-ALL-PASS');
  ws.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('REVIEW-ERROR', e.message); process.exit(1); });
