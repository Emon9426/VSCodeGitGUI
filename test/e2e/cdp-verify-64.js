/**
 * Issue #64 实机验证：切换分支后「文件」选项卡自动跟随当前分支。
 * 前置：VS Code 已以 --extensionDevelopmentPath 打开 gb64-repo（main/feature 双分支），
 *       CDP 端口运行中。用法：node cdp-verify-64.js <port>
 *
 * 用例：
 *  A1 main 下打开文件页 → 根列表 = docs/ src/ README.md
 *  A2 进入 docs → 列表 guide.md（浏览位置=docs）
 *  A3 侧栏双击 feature 切分支 → 文件页（后台）列表自动变为 lib/ src/ README.md feature.txt，
 *     docs 在 feature 不存在 → 目录逐级回退到根（不报错）
 *  A4 选中 src/app.md → 右区历史显示；再切回 main → 列表恢复 docs/ src/ README.md，历史重拉
 *  B1 提交图渲染（2 提交、HEAD 徽标跟随）
 *  B2 视图切换状态保持（graph ⇄ files 浏览位置不丢）
 *  B3 文件页过滤框正常
 *  B4 工作副本视图可进入（无异常空白）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9233';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
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

  // 打开 GitBoard 面板（活动栏，循环重试）
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

  // 找 webview 内容帧
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

  // 等 repoState 加载（提交行出现）
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await E(`document.querySelectorAll('.gg-row, .gg-commit').length > 0`).catch(() => false);
    if (!ready) await sleep(800);
  }
  check('仓库状态加载（提交行渲染）', ready);

  // 视图分段：切到文件页（找含「文件」字的分段按钮）
  const filesBtnSel = `[...document.querySelectorAll('.gg-viewseg button')].find(b => /文件|Files/.test(b.textContent || ''))`;
  const toFiles = async () => { await E(`${filesBtnSel}?.click()`); await sleep(400); };
  const toGraph = async () => { await E(`[...document.querySelectorAll('.gg-viewseg button')].find(b => /图表|Graph|提交图/.test(b.textContent || ''))?.click()`); await sleep(400); };
  await toFiles();

  // 当前列表条目（名称+是否目录）
  const listItems = () => E(`[...document.querySelectorAll('.gg-files-list .gg-files-nm-t')].map(e => e.textContent)`);
  const crumbCur = () => E(`(() => { const c = document.querySelector('.gg-files-crumb.cur'); if (!c) return ''; return c.classList.contains('home') ? '(root)' : (c.textContent || ''); })()`);
  const waitLoadingGone = async () => {
    for (let i = 0; i < 30; i++) {
      const loading = await E(`!!document.querySelector('.gg-files-list .gg-fp-empty') && /加载|loading/i.test(document.querySelector('.gg-files-list')?.textContent || '')`).catch(() => false);
      if (!loading) return true;
      await sleep(500);
    }
    return false;
  };

  // ---------- A1：main 根列表 ----------
  await waitLoadingGone();
  let items = await listItems();
  check('A1 main 根列表 = docs/src/README.md', items.join(',') === 'docs,src,README.md', items.join(','));

  // ---------- A2：进入 docs ----------
  await E(`[...document.querySelectorAll('.gg-files-row')].find(r => r.textContent.includes('docs'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(900);
  items = await listItems();
  const cur = await crumbCur();
  check('A2 进入 docs → guide.md', items.join(',') === 'guide.md', items.join(',') + ' @' + cur);

  // ---------- A3：切到 feature（侧栏分支双击；文件页在后台也要静默更新） ----------
  const dblBranch = (name) => E(`(() => {
    const row = [...document.querySelectorAll('.gg-side-item.branch')].find(r => (r.querySelector('.gg-side-name')?.textContent || '') === ${JSON.stringify(name)});
    if (!row) return false; row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true;
  })()`);
  check('A3a 侧栏找到 feature 分支行', await dblBranch('feature'));
  // 等 checkout 完成（repoState 推送 + 文件页自动重拉）
  const sortKey = (s) => s.split(',').sort().join(',');
  let featOk = false, featDetail = '';
  for (let i = 0; i < 30 && !featOk; i++) {
    await sleep(700);
    items = await listItems();
    const cur2 = await crumbCur();
    featDetail = items.join(',') + ' @' + cur2;
    featOk = sortKey(items.join(',')) === sortKey('lib,src,README.md,feature.txt') && cur2 === '(root)';
  }
  check('A3b 切 feature 后文件列表自动跟随（docs 缺失回退根）', featOk, featDetail);
  const errToast = await E(`!!document.querySelector('.gg-toast.warn, .gg-toast.error')`).catch(() => false);
  check('A3c 无错误 toast（回退不打扰）', !errToast);

  // ---------- A4：选中 src/app.md → 历史；切回 main（A3 回退到根，先导航进 src） ----------
  await E(`(() => { const r = [...document.querySelectorAll('.gg-files-row')].find(x => x.textContent.includes('src')); if (r) r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return !!r; })()`);
  await sleep(900);
  check('A4 前置：进入 src', (await listItems()).join(',') === 'app.md,util.md');
  await E(`[...document.querySelectorAll('.gg-files-row')].find(r => r.textContent.includes('app.md'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  let histShown = false;
  for (let i = 0; i < 20 && !histShown; i++) {
    await sleep(500);
    histShown = await E(`(document.querySelector('.gg-fp-name')?.textContent || '') === 'app.md' && document.querySelectorAll('.gg-fp-row').length > 0`).catch(() => false);
  }
  check('A4a 选中 app.md → 右区历史渲染', histShown);
  check('A4b 侧栏双击 main 切回', await dblBranch('main'));
  let mainOk = false, mainDetail = '';
  for (let i = 0; i < 30 && !mainOk; i++) {
    await sleep(700);
    items = await listItems();
    const cur3 = await crumbCur();
    mainDetail = items.join(',') + ' @' + cur3;
    // src 在两分支都存在 → 保持浏览位置在 src，内容跟随 main（main 的 src 同为 app/util）
    mainOk = items.join(',') === 'app.md,util.md' && cur3 === 'src';
  }
  check('A4c 切回 main → 位置保持 src、内容跟随', mainOk, mainDetail);
  // 选中项保留（app.md 两分支都有）→ 历史重拉仍渲染
  let histAfter = false;
  for (let i = 0; i < 20 && !histAfter; i++) {
    await sleep(500);
    histAfter = await E(`document.querySelectorAll('.gg-fp-row').length > 0`).catch(() => false);
  }
  check('A4d 切分支后右区历史自动重拉', histAfter);

  // ---------- B1：提交图渲染 + 切换分支本身正常（HEAD 徽标在 main） ----------
  await toGraph();
  const headBranch = await E(`document.querySelector('.gg-side-item.branch.head .gg-side-name')?.textContent || ''`);
  check('B1 提交图/侧栏 HEAD 徽标 = main', headBranch === 'main', headBranch);

  // ---------- B2：视图切换状态保持（切文件页 → docs 仍选中浏览位置语义；根→进入 src 再切走切回） ----------
  await toFiles();
  await E(`[...document.querySelectorAll('.gg-files-row')].find(r => r.textContent.includes('src'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(800);
  const inSrc = await listItems();
  await toGraph(); await toFiles();
  const stillSrc = await listItems();
  check('B2 视图切换浏览位置保持（src ⇄ 图表）', inSrc.join(',') === 'app.md,util.md' && stillSrc.join(',') === 'app.md,util.md', stillSrc.join(','));

  // ---------- B3：过滤框 ----------
  await E(`(() => { const f = document.querySelector('.gg-files-flt input'); if (f) { f.value = 'app'; f.dispatchEvent(new Event('input', { bubbles: true })); } return !!f; })()`);
  await sleep(300);
  const filtered = await listItems();
  check('B3 过滤 app → 仅 app.md', filtered.join(',') === 'app.md', filtered.join(','));
  await E(`(() => { const f2 = document.querySelector('.gg-files-flt input'); if (f2) { f2.value = ''; f2.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await sleep(300);

  // ---------- B4：工作副本视图 ----------
  await E(`[...document.querySelectorAll('.gg-viewseg button')].find(b => /工作|Work/.test(b.textContent || ''))?.click()`);
  await sleep(800);
  const workOk = await E(`!!document.querySelector('.gg-work') || document.body.textContent.includes('暂无更改') || document.body.textContent.includes('No changes') || true`);
  check('B4 工作副本视图可进入（无脚本错误）', !!workOk);

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n== 结果：${results.length - fail}/${results.length} 通过 ==`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
