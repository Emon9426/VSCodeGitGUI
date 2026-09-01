/**
 * v0.14.7 启动性能真机验证（隔离 profile + CDP）。
 * 用法：node cdp-verify-boot.js <port> <scenario>
 *   scenario=nogit —— 打开非 git 文件夹：外壳先行渲染 + 主区无仓库引导（不空白）
 *   scenario=repo  —— 打开正常 git 仓库：提交图正常加载渲染
 * 另采样启动期空态文案（scanning/loading 观察项，机器相关不作硬断言）。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入
const PORT = (() => {
  const raw = process.argv[2] || '9231';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
  return raw;
})();
const SCENARIO = process.argv[3] === 'repo' ? 'repo' : 'nogit';
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail ?? '' }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();

  // 打开 GitBoard（活动栏图标；Ctrl+Shift+P 兜底）
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const li = ab && [...ab.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return a && (a.getAttribute('aria-label') || '').includes('GitBoard');
      });
      if (li) { li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); li.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1200);
  }
  check('GitBoard 面板打开（活动栏）', opened);
  if (!opened) { await closeBrowser(); process.exit(1); }

  // 找 webview 内容帧（OOPIF iframe 目标里的 #active-frame.contentDocument）
  let gb = null;
  const bootTitles = [];   // 启动期空态采样（观察项）
  for (let i = 0; i < 20 && !gb; i++) {
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
  if (!gb) { console.log('FAIL: no webview'); await closeBrowser(); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // 启动期采样：300ms 间隔抓主区空态标题（机器相关，仅记录）
  const sampler = setInterval(() => {
    void E(`document.querySelector('.gg-empty.show .gg-empty-title')?.textContent || ''`).then(t => { if (t && bootTitles[bootTitles.length - 1] !== t) bootTitles.push(t); }).catch(() => undefined);
  }, 300);

  // 1) 外壳与版本
  const shell = await E(`(() => ({ ver: (document.body.textContent.match(/0\\.14\\.\\d+/) || ['NONE'])[0], viewseg: !!document.querySelector('.gg-viewseg'), toolbar: !!document.querySelector('.gg-toolbar'), sideProj: [...document.querySelectorAll('.gg-side-h')].some(h => /工程|Projects/.test(h.textContent || '')) }))()`);
  check('外壳渲染（工具栏+视图分段）', shell.toolbar && shell.viewseg, JSON.stringify(shell));
  check('版本 = 0.14.7', shell.ver === '0.14.7', shell.ver);
  check('侧栏工程区标题存在（非 git 部分先行）', shell.sideProj);

  if (SCENARIO === 'nogit') {
    await sleep(2500);   // 等扫描收尾（无仓库 → reposChanged(空) → 引导）
    const st = await E(`(() => {
      const e = document.querySelector('.gg-empty');
      const title = e?.querySelector('.gg-empty-title')?.textContent || '';
      const hint = e?.querySelector('.gg-empty-hint')?.textContent || '';
      const hintHidden = e?.querySelector('.gg-empty-hint')?.classList.contains('hidden');
      const spin = e?.querySelector('.gg-spinner')?.style.display;
      const repoEmpty = (document.querySelectorAll('.gg-side-sec')[1] || {}).querySelector?.('.gg-side-empty')?.textContent || '';
      const rows = document.querySelectorAll('.gg-list .gg-row').length;
      return { show: e?.classList.contains('show'), title, hint, hintHidden, spin, repoEmpty, rows };
    })()`);
    check('主区空态显示（不再空白）', st.show === true);
    check('主区标题=无仓库引导', /No Git repository found|当前工作区未发现/.test(st.title), st.title);
    check('主区副文案=打开仓库引导', /Open a folder|请先打开/.test(st.hint) && !st.hintHidden, st.hint);
    check('spinner 已收起', st.spin === 'none', String(st.spin));
    check('侧栏仓库区=无仓库文案', /No Git repository found|当前工作区未发现/.test(st.repoEmpty), st.repoEmpty);
    check('无提交行（无仓库）', st.rows === 0, 'rows=' + st.rows);
  } else {
    // repo 场景：等提交图渲染（大仓库首页 log 可能数秒）
    let rows = 0;
    for (let i = 0; i < 30 && rows === 0; i++) {
      await sleep(800);
      rows = await E(`document.querySelectorAll('.gg-list .gg-row').length`).catch(() => 0);
    }
    const st = await E(`(() => {
      const top = [...document.querySelectorAll('.gg-list .gg-row')].find(r => r.style.transform === 'translateY(0px)') || document.querySelector('.gg-list .gg-row');
      return {
        rows: document.querySelectorAll('.gg-list .gg-row').length,
        topSubject: top?.querySelector('.gg-subject')?.textContent || '',
        emptyShown: document.querySelector('.gg-empty')?.classList.contains('show'),
        repoItem: document.querySelector('.gg-side-item.repo')?.textContent || '',
        branchRows: (document.querySelectorAll('.gg-side-sec')[2] || {}).querySelectorAll?.('.gg-side-item').length || 0,
      };
    })()`);
    check('提交图渲染出提交行', st.rows > 0, 'rows=' + st.rows);
    check('顶行有提交说明', st.topSubject.length > 0, st.topSubject.slice(0, 40));
    check('空态已收起', st.emptyShown === false);
    check('侧栏仓库条目存在（reposChanged 生效）', /⑂/.test(st.repoItem), st.repoItem.slice(0, 30));
    check('侧栏分支区有条目', st.branchRows > 0, 'branches=' + st.branchRows);
  }

  clearInterval(sampler);
  console.log('启动期空态采样（观察项）: ' + (bootTitles.length ? bootTitles.join(' → ') : '(未捕获到中间态)'));
  const fails = results.filter(r => !r.pass).length;
  console.log(fails ? `BOOT-VERIFY FAIL x${fails}` : 'BOOT-VERIFY ALL-PASS');
  await closeBrowser();
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
