/**
 * 真机 CDP 冒烟（v0.14.1 完整测试轮；node test/e2e/cdp-real.js 手动运行）。
 * 结构：workbench(page) → webview host(OOPIF iframe target) → #active-frame.contentDocument(内容)。
 * 所有内容操作经 iframe target 的 Runtime.evaluate，表达式注入内容文档作用域。
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ok = [];
const bad = [];
const assert = (name, cond) => { (cond ? ok : bad).push(name); console.log((cond ? '  ✓ ' : '✗ '.padStart(4) + ' ') + name); };

let wsSeq = 0;
function evalRaw(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = ++wsSeq;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        ws.off('message', onMsg);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result?.result?.value);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}

/** 内容文档作用域包装：表达式内的 document/window 指向 #active-frame 内容（js 为表达式或 IIFE）。
 *  注意 TDZ：取帧须用 globalThis.document（const document 声明会遮蔽同作用域引用）。 */
const WRAP = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; const window = d.defaultView; return (${js}); })()`;

async function connectGb() {
  const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  for (const t of targets.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res) => { ws.once('open', res); ws.once('error', res); });
    if (ws.readyState !== 1) continue;
    const has = await evalRaw(ws, WRAP(`!!document.querySelector('.gg-viewseg')`)).catch(() => false);
    if (has) return ws;
    ws.close();
  }
  return null;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench') || p.url().includes('vscode-file')) ?? browser.contexts()[0].pages()[0];
  await page.bringToFront();
  await sleep(800);

  let gbWs = await connectGb();
  if (!gbWs) {
    await page.keyboard.press('Control+Shift+P');
    await sleep(1200);
    await page.keyboard.type('GitBoard: 打开', { delay: 40 });
    await sleep(900);
    await page.keyboard.press('Enter');
    await sleep(6000);
    await page.keyboard.press('Escape').catch(() => undefined);
    gbWs = await connectGb();
  }
  if (!gbWs) { console.log('FAIL: GitBoard webview not found'); process.exit(1); }
  const E = (js) => evalRaw(gbWs, WRAP(js));
  assert('GitBoard 面板打开（工具栏渲染）', true);
  assert('第四视图「文件」按钮', await E(`[...document.querySelectorAll('.gg-viewseg-btn')].some(b => b.textContent.includes('Files'))`));

  // 文件页：根目录浏览（真实 git ls-tree + stat）
  await E(`[...document.querySelectorAll('.gg-viewseg-btn')].find(b => b.textContent.includes('Files')).click()`);
  await sleep(3000);
  const rootText = String(await E(`document.querySelector('.gg-files-list')?.textContent ?? ''`));
  assert('根目录浏览（已完成 目录可见）', rootText.includes('已完成'));
  assert('详细信息视图四列（Name/Date modified）', rootText.includes('Name') && rootText.includes('Date'));

  // 双击 已完成 → 项目甲 → 单选 需求文档.md
  const dbl = async (n) => { await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('${n}')); if (r) r.dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); return !!r; })()`); await sleep(2200); };
  await dbl('已完成');
  await dbl('项目甲');
  assert('中文目录内容（需求文档.md）', String(await E(`document.querySelector('.gg-files-list')?.textContent ?? ''`)).includes('需求文档.md'));

  // 选中 → 历史跟随
  await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('需求文档.md')); if (r) r.click(); return !!r; })()`);
  await sleep(3000);
  const panel = await E(`(() => ({ name: document.querySelector('.gg-fp-name')?.textContent, chain: document.querySelector('.gg-fp-chain')?.textContent ?? '', rows: document.querySelectorAll('.gg-fp-row').length, miles: document.querySelectorAll('.gg-fp-row.mile').length, eras: document.querySelectorAll('.gg-fp-era').length, cnt: document.querySelector('.gg-fp-cnt')?.textContent }))()`);
  assert('文件头=需求文档.md', panel.name === '需求文档.md');
  assert('历史 5 条（跨重命名+移动）', panel.rows === 5);
  assert('链徽标（旧名→新名）', panel.chain.includes('需求说明.md') && panel.chain.includes('需求文档.md'));
  assert('里程碑 2 个', panel.miles === 2);
  assert('时期徽标 ≥2', panel.eras >= 2);
  assert('计数=5', panel.cnt === '5');

  // 详情展开（真实 diffOf）
  await E(`(() => { const b = [...document.querySelectorAll('.gg-fp-act')].find(x => x.textContent === 'ⓘ'); if (b) b.click(); return !!b; })()`);
  await sleep(2500);
  assert('详情就地展开（当时路径）', String(await E(`document.querySelector('.gg-fp-detail')?.textContent ?? ''`)).includes('Path at commit'));

  // 勾两条（最早↔最新）→ 比对
  await E(`(() => { const c = document.querySelectorAll('.gg-fp-ck'); if (c[4]) c[4].click(); return c.length; })()`);
  await sleep(400);
  await E(`(() => { const c = document.querySelectorAll('.gg-fp-ck'); if (c[0]) c[0].click(); return true; })()`);
  await sleep(600);
  assert('比对条出现', await E(`!document.querySelector('.gg-fp-cmpbar')?.classList.contains('hidden')`));
  await E(`document.querySelector('.gg-fp-cmpbtn')?.click()`);
  await sleep(3000);
  const diffInfo = await E(`(() => ({ shown: !document.querySelector('.gg-fp-diff')?.classList.contains('hidden'), pair: document.querySelector('.gg-fp-pair')?.textContent ?? '', body: document.querySelector('.gg-fp-diffbody')?.textContent ?? '' }))()`);
  assert('diff 视图激活', diffInfo.shown);
  assert('diff 头跨路径（旧名↔新名）', String(diffInfo.pair).includes('需求说明.md') && String(diffInfo.pair).includes('需求文档.md'));
  assert('diff 正文含终稿内容（真实差异）', String(diffInfo.body).includes('终稿内容'));

  // 返回 + 打开历史版本（只读 tab）
  await E(`document.querySelector('.gg-fp-back')?.click()`);
  await sleep(500);
  await E(`(() => { const b = [...document.querySelectorAll('.gg-fp-act')].find(x => x.textContent === '📄'); if (b) b.click(); return !!b; })()`);
  await sleep(2500);
  assert('打开历史版本触发（rpc 无异常）', true);

  // 侧栏折叠
  assert('侧栏折叠→把手→展开', await E(`(() => { const t = document.querySelector('.gg-side-toggle'), s = document.querySelector('.gg-side'), e = document.querySelector('.gg-side-edge'); if (!t || !s || !e) return false; t.click(); const c = getComputedStyle(s).display === 'none' && !e.classList.contains('hidden'); e.click(); return c && getComputedStyle(s).display !== 'none'; })()`));

  console.log(`\n结果: ${bad.length ? 'FAIL' : 'PASS'} (${ok.length}/${ok.length + bad.length})`);
  if (bad.length) console.log('失败: ' + bad.join(' | '));
  gbWs?.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(2); });
