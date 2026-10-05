/**
 * Issue #104 实机验证(v0.33.4)：push 被拒提示=常驻错误通知+「拉取并推送」直达按钮，一键链闭环。
 * 前置:VS Code 以 0.33.4(独立 profile/extensions-dir)+ --remote-debugging-port 打开 fixture 仓库
 *   phase a: %TEMP%/gb104-e2e/gb104a/work —— 本地领先(l.txt)且远端领先(r.txt),不同文件可干净合并;
 *            本地 origin/main 引用停在 base(push 前端 behind=0,必走 push→服务端拒→失败分诊路径)
 *   phase b: %TEMP%/gb104-e2e/gb104b/work —— 双方改 c.txt 同一行,pull 必冲突
 * 用法:node cdp-verify-104.js <port> a|b
 *
 *  A:push 被拒→常驻 error 通知(非 confirmDialog)+按钮→点击→pull 干净合并→自动续推→徽标清零
 *  B:push 被拒→按钮→pull 冲突→链条中止(自动切工作副本+冲突横幅+mergePushPaused 提示)→无自动推送
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9251';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const PHASE = (process.argv[3] === 'b') ? 'b' : 'a';
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
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

  check('分支扫描完成(main 行 + ahead 徽标)', await waitEval(E,
    `(() => { const r = document.querySelector('.gg-side-item.branch.head'); return !!r && !!r.querySelector('.gg-ab') && /\\d/.test(r.querySelector('.gg-ab').textContent || ''); })()`, 15000),
    await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || 'none'`));

  // ---------------- 点 Push → 服务端拒绝 → #104 修复形态 ----------------
  await E(`document.querySelector('[data-kind=push]')?.click()`);
  // 被拒分诊:常驻 error 通知 + 「拉取并推送」按钮(而非阻塞 confirmDialog)
  check('push 被拒→常驻错误通知出现', await waitEval(E, `!!document.querySelector('.gg-notif.error')`, 12000));
  const rej = await E(`(() => {
    const n = document.querySelector('.gg-notif.error');
    const btn = n?.querySelector('.gg-notif-acts button.primary');
    return {
      title: n?.querySelector('.gg-notif-title')?.textContent || '',
      body: n?.querySelector('.gg-notif-body')?.textContent || '',
      btn: btn?.textContent || '',
      hasDetail: !!n?.querySelector('.gg-notif-detail'),
    };
  })()`).catch(() => ({}));
  check('通知标题=推送被拒(non-fast-forward)', /推送被拒|push rejected/i.test(rej.title), rej.title);
  check('通知正文=远端包含本地没有的提交', /non-fast-forward/i.test(rej.body), rej.body);
  check('动作按钮=拉取并推送', /拉取并推送|pull and push/i.test(rej.btn), rej.btn);
  check('折叠详情含 git 完整输出', rej.hasDetail);
  const noModal = await E(`!document.querySelector('.gg-modal-overlay')`);
  check('#104 修复点:非阻塞 confirmDialog 形态', noModal);
  await sleep(2500);
  check('通知常驻(2.5s 后仍在,error 级不超时)', await E(`!!document.querySelector('.gg-notif.error .gg-notif-acts button.primary')`));

  // ---------------- 点「拉取并推送」→ 一键链 ----------------
  await E(`(() => { const btn = document.querySelector('.gg-notif.error .gg-notif-acts button.primary'); if (btn) btn.click(); return !!btn; })()`);
  check('点击后通知收起+pull 网络模态出现', await waitEval(E, `!!document.querySelector('.gg-net-overlay')`, 8000)
    && await E(`!document.querySelector('.gg-notif.error .gg-notif-acts button.primary')`),
    await E(`document.querySelector('.gg-net-title')?.textContent || ''`));

  if (PHASE === 'a') {
    // Phase A:pull 干净合并 → 自动续推 push → 全链完成
    check('A:链条完成(网络模态收口)', await waitEval(E, `!document.querySelector('.gg-net-overlay')`, 30000));
    check('A:同步完成徽标清零(与远端齐平)', await waitEval(E,
      `(() => { const r = document.querySelector('.gg-side-item.branch.head'); return !!r && !r.querySelector('.gg-ab'); })()`, 15000),
      await E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || 'gone'`));
    await page.screenshot({ path: '.playwright-mcp/e2e-104-a-final.png' }).catch(() => {});
  } else {
    // Phase B:pull 冲突 → 链条中止+明确提示,绝不自动推
    // (mergePushPaused 是 8s warn 通知——模态收口后立即轮询,勿先等其它长断言)
    // 本断言对应存量缺陷 #108(pull 冲突挂起链自 #45 起不可达,toast 死代码):修复 #108 前预期 FAIL
    check('B:mergePushPaused 明确提示(通知可见)【存量缺陷 #108】', await waitEval(E,
      `[...document.querySelectorAll('.gg-notif-title,.gg-notif-body,.gg-banner')].some(x => /拉取产生冲突|pull produced conflicts/i.test(x.textContent || ''))`, 12000));
    check('B:冲突→自动切工作副本视图(.gg-body.work-mode)', await waitEval(E, `!!document.querySelector('.gg-body.work-mode')`, 8000));
    check('B:冲突横幅出现(danger)', await waitEval(E, `!!document.querySelector('.gg-banner.danger')`, 15000),
      await E(`document.querySelector('.gg-banner.danger')?.textContent?.slice(0, 60) || ''`));
    await sleep(3500);
    check('B:无自动推送(网络模态已收口且不再出现)', await E(`!document.querySelector('.gg-net-overlay')`));
    // 合并挂起时推送按钮应被 blockedByMerge 禁用(#41/#7 既有语义),解决并完成合并后才恢复
    check('B:推送按钮被合并态禁用(不自动不诱导推送)', await E(`(() => { const b = document.querySelector('[data-kind=push]'); return !!b && b.disabled; })()`),
      await E(`document.querySelector('[data-kind=push]')?.title || ''`));
    await page.screenshot({ path: '.playwright-mcp/e2e-104-b-final.png' }).catch(() => {});
  }

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n#104 实机验证(phase ${PHASE}):${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
})();
