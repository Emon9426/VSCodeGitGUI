/**
 * DU 二进制冲突「以他人为准」实机回归（特殊会话解决后的流转）：
 *   node cdp-verify-du.js <port>
 * 前置：VS Code 已装 GitBoard（开发模式或 vsix）并打开 DU 冲突仓库
 *   （A.bin 本地删除/rename 为 B.bin，远端修改 A.bin → merge 停在 DU）。
 * 断言：
 *   L1 二进制特殊会话渲染 = 仅 theirs 卡片（Take theirs/Preview）+ Delete this file
 *   L2 点 Take theirs 后：A.bin 离开冲突组，合并器收起（单冲突）或切到下一冲突（多冲突）
 *   （git 层恢复远端版本由集成用例 mergeConflict.git.test.ts「DU 我删他改二进制」守护）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
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

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();

  // 活动栏打开 GitBoard
  let opened = false;
  for (let i = 0; i < 20 && !opened; i++) {
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
  console.log('panel-open:', opened);
  if (!opened) process.exit(1);

  // 找 webview iframe
  let gb = null;
  for (let i = 0; i < 30 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(500);
  }
  if (!gb) { console.log('FAIL: webview 帧未找到'); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));
  await sleep(2500);

  // 切工作副本视图
  await E(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Working Copy|工作副本/.test(x.title || x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(1200);
  const before = await E(`(() => ({
    conflicts: [...document.querySelectorAll('.gg-work-row.conflict')].map(r => r.querySelector('.gg-work-fpath')?.title),
  }))()`);
  console.log('BEFORE:', JSON.stringify(before));

  // 打开 A.bin 冲突合并器
  const openedMerge = await E(`(() => {
    const row = [...document.querySelectorAll('.gg-work-row.conflict')].find(r => /A\\.bin/.test(r.querySelector('.gg-work-fpath')?.title || ''));
    if (!row) return 'NO_ROW';
    const b = [...row.querySelectorAll('button')].find(x => /Merge|合并/.test(x.textContent));
    if (!b) return 'NO_MERGE_BTN';
    b.click(); return 'opened';
  })()`);
  console.log('open-merge:', openedMerge);
  await sleep(1800);

  // 合并器内容快照（二进制特殊会话：卡片/按钮）
  const snap = await E(`(() => {
    const root = document.querySelector('.gg-merge:not(.hidden)');
    if (!root) return { mergeOpen: false };
    return {
      mergeOpen: true,
      title: root.querySelector('.gg-merge-fname')?.textContent,
      special: root.querySelector('.gg-merge-special') ? true : false,
      specialTitle: root.querySelector('.gg-merge-special-title')?.textContent,
      cards: [...root.querySelectorAll('.gg-merge-card')].map(c => ({
        t: c.querySelector('.gg-merge-card-t')?.textContent,
        btns: [...c.querySelectorAll('button')].map(b => b.textContent.trim()),
        disabled: [...c.querySelectorAll('button')].map(b => b.disabled),
      })),
      soloBtn: root.querySelector('.gg-merge-card-solo button')?.textContent.trim(),
      toast: document.querySelector('.gg-notif')?.textContent.trim().slice(0, 160) || null,
    };
  })()`);
  console.log('MERGE-SNAP:', JSON.stringify(snap, null, 1));

  // 点“以他人为准”（theirs 卡片主按钮）
  const click = await E(`(() => {
    const root = document.querySelector('.gg-merge:not(.hidden)');
    if (!root) return 'NO_MERGE';
    const btn = [...root.querySelectorAll('.gg-merge-card button')].find(x => /以他人为准|Take theirs/i.test(x.textContent));
    if (!btn) return 'NO_BTN';
    if (btn.disabled) return 'BTN_DISABLED';
    btn.click();
    return 'clicked';
  })()`);
  console.log('CLICK:', click);
  await sleep(3000);

  // 点击后状态
  const after = await E(`(() => ({
    conflicts: [...document.querySelectorAll('.gg-work-row.conflict')].map(r => r.querySelector('.gg-work-fpath')?.title),
    mergeOpen: !document.querySelector('.gg-merge')?.classList.contains('hidden'),
    mergeTitle: document.querySelector('.gg-merge:not(.hidden) .gg-merge-fname')?.textContent,
  }))()`);

  // ---------- 断言 ----------
  const results = [];
  const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
  check('L1 特殊会话=二进制 theirs 单卡片+删除按钮',
    /Binary conflict|二进制/.test(String(snap?.specialTitle)) && snap?.cards?.length === 1 && /Theirs|他人/.test(String(snap?.cards[0]?.t)) && !!snap?.soloBtn,
    JSON.stringify(snap?.cards?.map(c => c.t)) + ' solo=' + snap?.soloBtn);
  check('L2a 点击成功派发', click === 'clicked', String(click));
  const resolved = !(after.conflicts || []).includes('A.bin');
  check('L2b A.bin 离开冲突组', resolved, JSON.stringify(after.conflicts));
  const advanced = after.mergeOpen === false || after.mergeTitle !== 'A.bin';
  check('L2c 合并器收起或切下一冲突（不停留原文件）', advanced,
    after.mergeOpen ? 'title=' + after.mergeTitle : 'closed');
  console.log(results.every(r => r.pass) ? 'ALL-PASS' : 'HAS-FAIL');

  gb.ws.close();
  await b.close();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
