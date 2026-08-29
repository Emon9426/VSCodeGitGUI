/** 0.14.4 真机面包屑布局验证：进入文件夹后 🏠/›/文件夹名 必须同一行（用户报告的穿帮场景） */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入（SSRF 面）。
const PORT = (() => {
  const raw = process.argv[2] || '9229';
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
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  // 打开 GitBoard
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

  const ver = await E(`document.body.textContent.match(/0\\.14\\.\\d+/)?.[0] || 'NONE'`);
  check('版本 = 0.14.4', ver === '0.14.4', ver);

  // 切到文件页
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files') || b.textContent.includes('文件'))?.click()`);
  await sleep(2500);

  // 根目录状态
  await page.screenshot({ path: '.playwright-mcp/v0144-crumb-root.png' });
  const rootGeo = await E(`(() => {
    const q = s => document.querySelector(s);
    const crumb = q('.gg-files-crumbs');
    const items = crumb ? [...crumb.querySelectorAll('.gg-files-crumb')] : [];
    return { containerDisplay: crumb ? getComputedStyle(crumb).display : null, n: items.length,
      ys: [...new Set(items.map(c => Math.round(c.getBoundingClientRect().y)))],
      addrRect: q('.gg-files-addr') ? [Math.round(q('.gg-files-addr').getBoundingClientRect().y), Math.round(q('.gg-files-addr').getBoundingClientRect().height)] : null };
  })()`);
  check('根目录：容器为 flex 行', rootGeo.containerDisplay === 'flex', 'display=' + rootGeo.containerDisplay);

  // 双击进入第一个文件夹（repo 有中文目录）
  const dirName = await E(`(() => { const r = document.querySelector('.gg-files-table .gg-files-row'); if (!r) return null; const t = r.querySelector('.gg-files-nm-t'); return t ? t.textContent : null; })()`);
  check('列表有首行（目录）', !!dirName, 'name=' + dirName);
  await E(`(() => { const r = document.querySelector('.gg-files-table .gg-files-row'); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await sleep(2000);

  // 进入后：截图 + 几何断言（核心：全部 crumb 同一 y、房子 x 最左、名字在右侧、都在地址栏行内）
  await page.screenshot({ path: '.playwright-mcp/v0144-crumb-subdir.png' });
  const geo = await E(`(() => {
    const q = s => document.querySelector(s);
    const crumb = q('.gg-files-crumbs');
    const items = crumb ? [...crumb.querySelectorAll('.gg-files-crumb')] : [];
    const seps = crumb ? [...crumb.querySelectorAll('.gg-files-crumb-sep')] : [];
    const rects = items.map(c => c.getBoundingClientRect());
    const addr = q('.gg-files-addr').getBoundingClientRect();
    return {
      containerDisplay: crumb ? getComputedStyle(crumb).display : null,
      containerFlexDir: crumb ? getComputedStyle(crumb).flexDirection : null,
      n: items.length, sepN: seps.length,
      labels: items.map(c => c.textContent),
      rects: rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]),
      ys: [...new Set(rects.map(r => Math.round(r.y)))],
      xsAsc: rects.length >= 2 && rects[rects.length - 1].x > rects[0].x,
      inAddrRow: rects.every(r => r.y >= addr.y - 1 && r.y + r.height <= addr.y + addr.height + 1),
      addrH: Math.round(addr.height),
      text: crumb ? crumb.textContent : '',
    };
  })()`);
  check('子目录：容器为 flex row', geo.containerDisplay === 'flex' && geo.containerFlexDir === 'row', geo.containerDisplay + '/' + geo.containerFlexDir);
  check('子目录：面包屑项 ≥2（🏠 + 名；› 分隔符独立类不计）', geo.n >= 2, 'n=' + geo.n + ' labels=' + JSON.stringify(geo.labels));
  check('子目录：所有项同一水平线（y 唯一）', geo.ys.length === 1, 'ys=' + JSON.stringify(geo.ys));
  check('子目录：文件夹名在房子右侧', geo.xsAsc, JSON.stringify(geo.rects));
  check('子目录：全部落在地址栏 28px 行内', geo.inAddrRow, 'addrH=' + geo.addrH);
  check('子目录：房子是第一项', geo.labels.length && geo.labels[0] === '🏠', 'text=' + geo.text);

  // 再进一层（若子目录还有目录），验证多级面包屑仍单行
  const deeper = await E(`(() => { const rows = [...document.querySelectorAll('.gg-files-table .gg-files-row')]; const first = rows[0]; if (!first) return null; const t = first.querySelector('.gg-files-nm-t'); return t ? t.textContent : null; })()`);
  if (deeper) {
    await E(`(() => { document.querySelector('.gg-files-table .gg-files-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    await sleep(1800);
    const g2 = await E(`(() => { const c = document.querySelector('.gg-files-crumbs'); const items = [...c.querySelectorAll('.gg-files-crumb')]; const ys = [...new Set(items.map(i => Math.round(i.getBoundingClientRect().y)))]; return { n: items.length, ys, text: c.textContent }; })()`);
    check('二级子目录：多级面包屑仍同行', g2.n >= 3 && g2.ys.length === 1, JSON.stringify(g2));
    await page.screenshot({ path: '.playwright-mcp/v0144-crumb-deep.png' });
  } else {
    console.log('SKIP | 二级目录不存在，跳过多级验证');
  }

  // 回根目录（点房子）
  await E(`(() => { document.querySelector('.gg-files-crumb').click(); return true; })()`);
  await sleep(1200);
  const backN = await E(`document.querySelectorAll('.gg-files-crumbs .gg-files-crumb').length`);
  check('点房子回到根目录', backN === 1, 'n=' + backN);

  const fails = results.filter(r => !r.pass);
  console.log(fails.length ? `\nTOTAL: ${results.length - fails.length}/${results.length} PASS` : `\nTOTAL: ${results.length}/${results.length} ALL PASS`);
  gb.ws.close();
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
