/** 真机穿模诊断（参数化端口）：文件页地址栏/命令条几何与样式检查 + 版本确认 + 滚动复测 + 截图
 *  用法：node test/e2e/cdp-addr-diag.js [port=9225] [screenshotName=real-addr-check]
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入，
// 防 "9227@evil.com" 之类参数被解析为 userinfo+恶意主机（SSRF 面）。
const PORT = (() => {
  const raw = process.argv[2] || '9225';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
  return raw;
})();
const SHOT = process.argv[3] || 'real-addr-check';
let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => p.url().startsWith('devtools') ? false : true) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(800);
  await page.keyboard.press('Control+Alt+G');
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

  // 0) 版本确认：工具栏版本标签必须含 0.14.3（排除旧 webview/旧扩展）
  const ver = await E(`(document.querySelector('.gg-toolbar')?.textContent || document.body.textContent.slice(0, 400)).match(/0\\.14\\.\\d+/)?.[0] || document.body.textContent.match(/v?0\\.1[34]\\.\\d+/)?.[0] || 'NO-VERSION-LABEL'`);
  console.log('VERSION:', ver);

  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files') || b.textContent.includes('文件'))?.click()`);
  await sleep(3000);

  // 1) 深色主题下背景不透明度检测：rgba alpha 必须 =1（或 rgb 纯色）
  const opaque = await E(`(() => {
    const alpha = (sel) => { const el = document.querySelector(sel); if (!el) return 'missing'; const c = getComputedStyle(el).backgroundColor; const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return c; const parts = m[1].split(','); return parts.length === 4 ? parseFloat(parts[3]) : 1; };
    return { addr: alpha('.gg-files-addr'), cmdbar: alpha('.gg-files-cmdbar'), cbtn: alpha('.gg-files-cbtn'), files: alpha('.gg-files'), head: alpha('.gg-files-head') };
  })()`);
  console.log('OPACITY:', JSON.stringify(opaque));

  await page.screenshot({ path: `.playwright-mcp/${SHOT}.png` });
  console.log('screenshot saved');

  const collect = () => E(`(() => {
    const q = s => document.querySelector(s);
    const rect = el => { const r = el && el.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; };
    const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p) : null;
    return {
      addr: { rect: rect(q('.gg-files-addr')), bg: cs(q('.gg-files-addr'), 'background-color'), pos: cs(q('.gg-files-addr'), 'position'), z: cs(q('.gg-files-addr'), 'z-index'), display: cs(q('.gg-files-addr'), 'display'), text: (q('.gg-files-addr') || {}).textContent ? q('.gg-files-addr').textContent.slice(0, 50) : null },
      cmdbar: { rect: rect(q('.gg-files-cmdbar')), bg: cs(q('.gg-files-cmdbar'), 'background-color'), z: cs(q('.gg-files-cmdbar'), 'z-index') },
      list: { rect: rect(q('.gg-files-list')), overflow: cs(q('.gg-files-list'), 'overflow'), scrollY: q('.gg-files-list') ? Math.round(q('.gg-files-list').scrollTop) : null },
      filesBox: { rect: rect(q('.gg-files')), overflow: cs(q('.gg-files'), 'overflow') },
      head: { rect: rect(q('.gg-files-head')) },
      firstRow: rect(q('.gg-files-table .gg-files-row')),
      thRect: rect(q('.gg-files-table th')),
      theme: cs(q('.gg-files'), '--vscode-sideBar-background'),
      bodyOverflow: cs(q('.gg-files-wrap'), 'overflow') + '/' + cs(q('.gg-main'), 'overflow'),
      wrapRect: rect(q('.gg-files-wrap')),
    };
  })()`);

  console.log('BEFORE-SCROLL:', JSON.stringify(await collect(), null, 1));

  // 2) 滚动列表到底部再复测：穿模若存在会在滚动后暴露（sticky 表头/溢出内容覆盖地址栏）
  await E(`(() => { const l = document.querySelector('.gg-files-list'); if (l) { l.scrollTop = l.scrollHeight; } return true; })()`);
  await sleep(400);
  console.log('AFTER-SCROLL:', JSON.stringify(await collect(), null, 1));

  // 3) 断言：地址栏/命令条与列表无几何重叠，且地址栏不透明
  const fin = await collect();
  const overlap = (a, b) => a && b && !(a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]);
  const problems = [];
  if (overlap(fin.addr.rect, fin.list.rect)) problems.push('addr/list overlap');
  if (overlap(fin.cmdbar.rect, fin.list.rect)) problems.push('cmdbar/list overlap');
  if (fin.addr.pos !== 'relative' && fin.addr.pos !== 'static') problems.push('addr pos=' + fin.addr.pos);
  console.log(problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'GEOMETRY-OK');
  gb.ws.close();
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
