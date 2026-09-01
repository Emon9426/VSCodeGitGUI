/** 0.14.6 真机 GitHub 风图形列验证（默认风格即 github）：
 *  ① 版本 0.14.6；② lane 竖线为 GitHub 深色板首色（紫 #8957e5，区别于基线蓝 #4fc1ff）；
 *  ③ HEAD 节点无红色圆环（GitHub 风用背景粗边）；④ 首行节点存在（圆点实心）。 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9231';
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
  check('版本 = 0.14.6', ver === '0.14.6', ver);

  // 确认在提交图视图（默认视图）
  await sleep(1500);
  const canvasInfo = await E(`(() => {
    const cv = document.querySelector('.gg-graph-canvas');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), cssW: cv.style.width, attrW: cv.width };
  })()`);
  check('图形 canvas 存在', !!canvasInfo, JSON.stringify(canvasInfo));

  // 像素断言：扫描 canvas 前 3 行区域
  const pix = await E(`(() => {
    const cv = document.querySelector('.gg-graph-canvas');
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    const img = ctx.getImageData(0, 0, W, H).data;
    const px = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 4; return [img[i], img[i+1], img[i+2], img[i+3]]; };
    // lane0 中心 x ≈ (8 + 0*12) + 0.5，行 0 中心 y ≈ 12（R=24）
    const laneX = 8, rowY = 12;
    // ① lane0 竖线颜色（行 1 中心，避开节点）：应为紫 #8957e5 ≈ (137,87,229)
    let lane = null;
    for (let dy = -6; dy <= 6; dy++) { const c = px(laneX * dpr, (rowY + 24 + dy) * dpr); if (c[3] > 100) { lane = c; break; } }
    // ② HEAD 节点周边红环检测：环带半径 5.7±1 范围采样（github 风应无红）
    const isRed = (c) => c[3] > 100 && c[0] > 170 && c[0] - c[1] > 60 && c[0] - c[2] > 60;
    let redNear = 0;
    for (let a = 0; a < 360; a += 5) {
      const rad = a * Math.PI / 180;
      for (const rr of [4.5, 5.7, 6.9]) {
        const c = px((laneX + rr * Math.cos(rad)) * dpr, (rowY + rr * Math.sin(rad)) * dpr);
        if (isRed(c)) redNear++;
      }
    }
    // ③ 首行节点：中心应为深色（紫实心点）而非透明
    const center = px(laneX * dpr, rowY * dpr);
    // ④ 整体紫色像素计数（GitHub 板首色）
    let purpleCount = 0;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i+1], bl = img[i+2];
      if (img[i+3] > 100 && r > 100 && r < 190 && g < 140 && bl > 180) purpleCount++;
    }
    return { lane, redNear, center, purpleCount };
  })()`);
  check('lane 竖线为 GitHub 紫（非基线蓝）', !!pix.lane && pix.lane[2] > 180 && pix.lane[2] - pix.lane[1] > 60, 'lane=' + JSON.stringify(pix.lane));
  check('HEAD 无红色圆环', pix.redNear === 0, 'redNear=' + pix.redNear);
  check('首行 HEAD 节点实心', !!pix.center && pix.center[3] > 100, 'center=' + JSON.stringify(pix.center));
  check('GitHub 紫色系像素存在', pix.purpleCount > 20, 'purple=' + pix.purpleCount);

  await page.screenshot({ path: '.playwright-mcp/v0146-github-style.png' }).catch(() => {});
  const fails = results.filter(r => !r.pass);
  console.log(fails.length ? `\nTOTAL: ${results.length - fails.length}/${results.length} PASS` : `\nTOTAL: ${results.length}/${results.length} ALL PASS`);
  gb.ws.close();
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
