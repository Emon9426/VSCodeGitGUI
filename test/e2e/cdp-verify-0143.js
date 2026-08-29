/** 0.14.3 真机综合验证：类名唯一性 + 文件页几何 + 图视图详情面板 + 双视图切换互不污染 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入，
// 防 "9227@evil.com" 之类参数被解析为 userinfo+恶意主机（SSRF 面）。
const PORT = (() => {
  const raw = process.argv[2] || '9228';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
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

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  // 打开 GitBoard（活动栏图标点击）
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
    if (!opened) await sleep(1500);
  }
  check('GitBoard 面板打开', opened);
  await sleep(6000);

  let gb = null;
  for (let i = 0; i < 15 && !gb; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) { gb = { ws, W }; break; }
      ws.close();
    }
    if (!gb) await sleep(1000);
  }
  if (!gb) { console.log('FAIL: no webview'); process.exit(1); }
  const E = (js) => evalRaw(gb.ws, gb.W(js));

  // 1) 版本
  const ver = await E(`document.body.textContent.match(/0\\.14\\.\\d+/)?.[0] || 'NONE'`);
  check('版本 = 0.14.3', ver === '0.14.3', ver);

  // 2) 类名唯一性：详情面板已改名，.gg-files 仅文件页一份
  const uniq = await E(`({ files: document.querySelectorAll('.gg-files').length, filesHead: document.querySelectorAll('.gg-files-head').length, dfiles: document.querySelectorAll('.gg-dfiles').length, dfilesHead: document.querySelectorAll('.gg-dfiles-head').length })`);
  check('.gg-files 唯一（无重复空壳）', uniq.files === 1, JSON.stringify(uniq));
  check('.gg-files-head 唯一', uniq.filesHead === 1);
  check('详情面板 gg-dfiles 存在', uniq.dfiles >= 1 && uniq.dfilesHead >= 1);

  // 3) 文件页几何与不透明（深色）
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files') || b.textContent.includes('文件'))?.click()`);
  await sleep(2500);
  const geo = await E(`(() => {
    const q = s => document.querySelector(s);
    const rect = el => { const r = el && el.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; };
    const alpha = (sel) => { const el = q(sel); if (!el) return -1; const c = getComputedStyle(el).backgroundColor; const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return -2; const p = m[1].split(','); return p.length === 4 ? parseFloat(p[3]) : 1; };
    const overlap = (a, b) => a && b && !(a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]);
    const addr = rect(q('.gg-files-addr')), cmdbar = rect(q('.gg-files-cmdbar')), list = rect(q('.gg-files-list'));
    return { addr, cmdbar, list, addrA: alpha('.gg-files-addr'), cmdbarA: alpha('.gg-files-cmdbar'), cbtnA: alpha('.gg-files-cbtn'),
      noOverlap: !overlap(addr, list) && !overlap(cmdbar, list), addrText: (q('.gg-files-addr') || {}).textContent || '' };
  })()`);
  check('地址栏不透明', geo.addrA === 1, 'alpha=' + geo.addrA);
  check('命令条不透明', geo.cmdbarA === 1, 'alpha=' + geo.cmdbarA);
  check('命令按钮不透明', geo.cbtnA === 1, 'alpha=' + geo.cbtnA);
  check('地址栏/命令条与列表无重叠', geo.noOverlap, JSON.stringify({ addr: geo.addr, cmdbar: geo.cmdbar, list: geo.list }));
  check('地址栏有面包屑内容', /🏠|🗂/.test(geo.addrText), geo.addrText.slice(0, 30));
  await page.screenshot({ path: '.playwright-mcp/v0143-files-dark.png' });

  // 4) 图视图：选提交 → 详情面板变更文件列表（改名后的 gg-dfiles）
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Graph') || b.textContent.includes('图') || b.textContent.includes('提交'))?.click()`);
  await sleep(2000);
  await E(`(() => { const r = document.querySelector('.gg-list .gg-row'); if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!r; })()`);
  await sleep(1200);
  const det = await E(`(() => {
    const q = s => document.querySelector(s);
    const dh = q('.gg-dfiles-head');
    const dl = q('.gg-dfiles');
    const rows = q('.gg-dfiles') ? q('.gg-dfiles').querySelectorAll('.gg-file, .gg-file-group').length : 0;
    const cs = dh ? getComputedStyle(dh) : null;
    return { hasHead: !!dh, hasList: !!dl, rows, marginTop: cs ? cs.marginTop : null, display: cs ? cs.display : null, overflow: dl ? getComputedStyle(dl).overflow : null, minWidth: dl ? getComputedStyle(dl).minWidth : null, sha: (q('.gg-detail-sha') || {}).textContent || '' };
  })()`);
  check('详情面板头部（gg-dfiles-head）渲染', det.hasHead, JSON.stringify(det));
  check('详情面板变更文件列表渲染', det.hasList && det.rows > 0, 'rows=' + det.rows);
  check('变更文件容器未被文件页规则污染（overflow 可见）', det.overflow !== 'hidden', 'overflow=' + det.overflow + ' minWidth=' + det.minWidth);
  check('详情面板头部样式正确（margin-top:8px）', det.marginTop === '8px', 'marginTop=' + det.marginTop);
  await page.screenshot({ path: '.playwright-mcp/v0143-detail-dark.png' });

  // 5) 回切文件页仍正常
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files') || b.textContent.includes('文件'))?.click()`);
  await sleep(1500);
  const back = await E(`(() => { const a = document.querySelector('.gg-files-addr'); const r = a && a.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 100 && r.height > 10 } : null; })()`);
  check('回切文件页地址栏正常', !!(back && back.visible), JSON.stringify(back));

  const fails = results.filter(r => !r.pass);
  console.log(fails.length ? `\nTOTAL: ${results.length - fails.length}/${results.length} PASS, FAIL x${fails.length}` : `\nTOTAL: ${results.length}/${results.length} ALL PASS`);
  gb.ws.close();
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
