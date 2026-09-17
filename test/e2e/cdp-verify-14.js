/**
 * Issue #14 实机验证：本地名(master)≠上游名(origin/main) 时推送精确落上游分支。
 * 前置：fixture %TEMP%/gb14-clone（master 分支、上游 origin/main、ahead 1）。
 * 用法：node cdp-verify-14.js <port>
 *
 * A1 Push 成功（无错误通知）
 * A2 远端 bare：main 前进到本地 HEAD；master 分支未被创建（不污染同名旧分支）
 * A3 成本消息显示「main → origin」（refspec 目标段）
 * A4 提交图 ahead 徽标消失（对上游已同步）
 */
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9233';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const CLONE = process.env.TEMP.replace(/\\/g, '/') + '/gb14-clone';
const BARE = process.env.TEMP.replace(/\\/g, '/') + '/gb14-origin.git';
const gitOf = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
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
  const headBefore = gitOf(CLONE, 'rev-parse', 'HEAD');
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

  let gb = null;
  for (let i = 0; i < 25 && !gb; i++) {
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
  if (!gb) { console.log('FAIL | webview 帧未找到'); await b.close(); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await E(`document.querySelectorAll('.gg-row').length > 0`).catch(() => false);
    if (!ready) await sleep(800);
  }
  check('A1 前置 仓库加载', ready);

  // 侧栏 HEAD 分支应显示 ↑1（master ahead origin/main）
  const badge0 = await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || ''`);
  check('A1 前置 HEAD(master) 领先徽标 ↑1', /↑\s*1|a1/i.test(badge0), badge0);

  // 点 Push
  await E(`document.querySelector('.gg-tb-btn[data-kind="push"]')?.click()`);

  // 等推送完成（徽标消失 = 对上游同步）
  let badge = badge0, msg = '';
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    badge = await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || ''`);
    msg = await E(`(document.querySelector('.gg-opstatus')?.textContent || '') + '|' + ([...document.querySelectorAll('.gg-notif')].map(n => n.textContent).join('§'))`);
    if (badge.trim() === '') break;
  }
  const errNotif = await E(`!!document.querySelector('.gg-notif.error')`).catch(() => false);
  check('A2 Push 无错误通知', !errNotif, msg.slice(0, 80));

  // 远端 bare 硬断言
  const remoteMain = gitOf(BARE, 'rev-parse', 'refs/heads/main');
  const remoteMasterList = gitOf(BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/master');
  check('A3 远端 main 前进到本地 HEAD', remoteMain === headBefore, `${remoteMain.slice(0, 7)} vs ${headBefore.slice(0, 7)}`);
  check('A4 远端 master 未被污染（无同名分支）', remoteMasterList === '', remoteMasterList);

  // 成功消息含「main → origin」
  let doneMsg = '';
  for (let i = 0; i < 10; i++) {
    doneMsg = await E(`document.querySelector('.gg-opstatus')?.textContent || ''`);
    if (/main\s*→\s*origin|main -> origin/i.test(doneMsg)) break;
    await sleep(400);
  }
  check('A5 成功消息显示 main → origin', /main\s*→\s*origin/i.test(doneMsg), doneMsg.slice(0, 60));
  check('A6 ahead 徽标消失（对上游同步）', badge.trim() === '', badge);

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
