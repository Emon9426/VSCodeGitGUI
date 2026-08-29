/** 0.14.5 真机绝对路径地址栏验证：用户场景——输入绝对路径回车
 *  ① 仓库根绝对路径 → 跳回根目录；② 子目录绝对路径（带引号+反斜杠）→ 导航；
 *  ③ 越仓绝对路径（用户原样 D:\01_WorkSpace\01_Project\09_GitGraph，在测试仓库之外）→ 红框+明确 toast；
 *  ④ 仓库内不存在的相对路径 → 红框+「路径不存在」toast。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
// 端口只接受纯数字整数（2000-65535）：URL 主机固定字面量 127.0.0.1，端口经校验后才拼入（SSRF 面）。
const PORT = (() => {
  const raw = process.argv[2] || '9230';
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
  check('版本 = 0.14.5', ver === '0.14.5', ver);

  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files') || b.textContent.includes('文件'))?.click()`);
  await sleep(2500);

  // 从 DOM 读当前仓库根（侧栏/状态里不可靠，直接用 webview 里 S.repos——通过面包屑外途径拿不到就走宿主消息）
  // 更稳妥：用 webview 全局状态。main.js 里 S 不一定挂在 window——通过 crumbs+导航验证代替。
  // 绝对路径由前端用 S.repos root 换算，root= C:\Users\Emon\AppData\Local\Temp\gb-real-repo（启动参数即工作区）
  const ROOT = 'C:\\\\Users\\\\Emon\\\\AppData\\\\Local\\\\Temp\\\\gb-real-repo';

  const typeAddr = async (val, waitMs = 1500) => {
    await E(`(() => { const sp = document.querySelector('.gg-files-addr-space'); if (sp) sp.click(); return !!sp; })()`);
    await sleep(200);
    await E(`(() => { const i = document.querySelector('.gg-files-addr-input'); if (!i) return false; i.value = ${JSON.stringify(val)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(waitMs);   // 红框 1.5s 自动消退——查红框须用短等待（≤600ms）
  };
  const crumbText = () => E(`document.querySelector('.gg-files-crumbs') ? document.querySelector('.gg-files-crumbs').textContent : null`);
  const errState = () => E(`(() => { const a = document.querySelector('.gg-files-addr'); const t = document.querySelector('.gg-toast'); return { err: a ? a.classList.contains('err') : null, toast: t ? t.textContent : null }; })()`);
  const clearToast = () => E(`(() => { document.querySelectorAll('.gg-toast').forEach(t => t.remove()); return true; })()`);

  // ① 仓库根绝对路径（反斜杠原样）→ 应回到根目录（面包屑仅 🏠）
  await typeAddr('C:\\Users\\Emon\\AppData\\Local\\Temp\\gb-real-repo');
  let c1 = await crumbText();
  check('① 仓库根绝对路径 → 回根目录', c1 === '🏠', 'crumbs=' + JSON.stringify(c1));

  // ② 子目录绝对路径，资源管理器「复制文件地址」形态（引号+反斜杠）→ 导航进 已完成
  await typeAddr('"C:\\Users\\Emon\\AppData\\Local\\Temp\\gb-real-repo\\已完成"');
  let c2 = await crumbText();
  check('② 带引号子目录绝对路径 → 导航', c2 === '🏠›已完成', 'crumbs=' + JSON.stringify(c2));

  // ③ 越仓绝对路径（用户原样输入）→ 红框 + toast 含仓库根提示
  await typeAddr('D:\\01_WorkSpace\\01_Project\\09_GitGraph', 400);
  let s3 = await errState();
  check('③ 越仓路径 → 红框', s3.err === true, 'err=' + s3.err);
  check('③ 越仓路径 → toast 明确提示（含仓库根）', !!s3.toast && /仓库根|repo root/i.test(s3.toast) && /gb-real-repo/i.test(s3.toast), 'toast=' + JSON.stringify(s3.toast));
  await clearToast();
  await sleep(1700);   // 等红框 1.5s 自动消退

  // ④ 仓库内不存在的相对路径 → 红框 + 「路径不存在」toast
  await typeAddr('已完成/不存在的目录', 400);
  let s4 = await errState();
  check('④ 不存在相对路径 → 红框', s4.err === true, 'err=' + s4.err);
  check('④ 不存在相对路径 → toast「路径不存在」', !!s4.toast && /路径不存在|not found/i.test(s4.toast), 'toast=' + JSON.stringify(s4.toast));
  await clearToast();

  // ⑤ 红框 1.5s 后自动消退（不留永久红框）
  await sleep(1700);
  let s5 = await errState();
  check('⑤ 红框自动消退', s5.err === false, 'err=' + s5.err);

  await page.screenshot({ path: '.playwright-mcp/v0145-absaddr.png' });
  const fails = results.filter(r => !r.pass);
  console.log(fails.length ? `\nTOTAL: ${results.length - fails.length}/${results.length} PASS` : `\nTOTAL: ${results.length}/${results.length} ALL PASS`);
  gb.ws.close();
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
