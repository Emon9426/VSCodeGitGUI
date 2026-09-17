/**
 * Issue #11 实机验证：42000 提交仓库，日期窗口命中位于 41760+ 深度。
 * 前置：fixture %TEMP%/gb11-big（fast-import 造，命中日 2026-07-02 = 240 条 DEEP-HIT）。
 * 用法：node cdp-verify-11.js <port>
 *
 * A1 首页加载（无过滤 500 条）
 * A2 设日期过滤 2026-07-02 → 宿主 fill 首轮 0-20000 空页 → 空列表 + 空态「继续扫描」按钮
 * A3 点继续扫描（第 2 轮 20000-40000 空页）→ 熔断后按钮仍在（canScan 含熔断态）
 * A4 再点继续扫描（第 3 轮 40000-42000 命中）→ 240 条 DEEP-HIT 到手（完整列表）
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
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await E(`document.querySelectorAll('.gg-row').length > 0`).catch(() => false);
    if (!ready) await sleep(1000);
  }
  check('A1 首页加载（大仓 42000 提交）', ready);

  // A2：设日期过滤（since=until=2026-07-02）→ 空列表 + 空态「继续扫描」
  await E(`(() => {
    const set = (el, v) => { if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    const dates = [...document.querySelectorAll('.gg-date-input')];
    set(dates[0], '2026-07-02');
    set(dates[1], '2026-07-02');
    return dates.length;
  })()`);
  // 宿主 fill 首轮（0-20000）需时：轮询空态按钮出现（120s 上限）
  let emptyBtn = null;
  for (let i = 0; i < 120 && !emptyBtn; i++) {
    await sleep(1000);
    emptyBtn = await E(`(() => { const b = document.querySelector('.gg-empty .gg-empty-scan'); return (b && b.style.display !== 'none' && !b.disabled) ? b.textContent : null; })()`);
  }
  check('A2 过滤 0 命中（深处）→ 空态出现「继续扫描」', !!emptyBtn, emptyBtn || '(none)');

  const clickScan = () => E(`(() => { const b = document.querySelector('.gg-empty .gg-empty-scan'); if (b && !b.disabled) { b.click(); return true; } return false; })()`);
  /** 点击后等一轮 fill 完成：disabled（scanPending 在途）→ enabled（appended 复位）；超时 false */
  const waitRoundDone = async (label) => {
    let sawDis = false;
    for (let i = 0; i < 150; i++) {
      await sleep(1000);
      const st = await E(`(() => { const b = document.querySelector('.gg-empty .gg-empty-scan'); if (!b) return 'gone'; return b.disabled ? 'dis' : 'ok'; })()`);
      if (st === 'gone') return true;    // 列表非空（空态消失）= 命中到手
      if (st === 'dis') sawDis = true;
      if (sawDis && st === 'ok') return true;
    }
    console.log(`WARN ${label} 等待超时（sawDis=${sawDis}）`);
    return sawDis;
  };

  // A3：第 2 轮（20000-40000 空页）→ 熔断后按钮仍在 → 可再点
  const clicked2 = await clickScan();
  const round2Done = clicked2 ? await waitRoundDone('round2') : false;
  const capBtnBack = await E(`(() => { const b = document.querySelector('.gg-empty .gg-empty-scan'); return !!(b && b.style.display !== 'none' && !b.disabled); })()`);
  check('A3 两轮空扫熔断后「继续扫描」仍可用', clicked2 && round2Done && !!capBtnBack);

  // A4：持续「继续扫描」直至命中（CAP=20000/轮，命中深度 ~62520 需再扫 2 轮+；
  //     熔断 → 续扫空页 → 再续扫……每轮用户点一次按钮，与真实使用一致）
  let hitOk = false, hitDetail = '';
  for (let round = 0; round < 5 && !hitOk; round++) {
    const clicked = await clickScan();
    if (!clicked) { await sleep(2000); continue; }
    await waitRoundDone(`resume#${round}`);
    const st = await E(`(() => {
      const footer = document.querySelector('.gg-list-footer')?.textContent ?? '';
      const rows = [...document.querySelectorAll('.gg-list .gg-row')].filter(r => r.style.display !== 'none');
      const anyHit = rows.some(r => /DEEP-HIT/.test(r.textContent || ''));
      const emptyGone = !document.querySelector('.gg-empty')?.classList.contains('show');
      return { footer: footer.trim(), anyHit, emptyGone, top: (rows[0]?.querySelector('.gg-subject')?.textContent ?? '').slice(0, 30) };
    })()`);
    hitDetail = JSON.stringify(st);
    hitOk = !!st && st.emptyGone && st.anyHit && /已加载 240 条|240 commits loaded/.test(st.footer);
  }
  check('A4 继续扫描后命中 DEEP-HIT 完整到手（240 条）', hitOk, hitDetail.slice(0, 100));

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
