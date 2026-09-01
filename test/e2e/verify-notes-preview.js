/** 快速笔记 UI 预览页验证：五场景切换 + 交互冒烟（本地 http 服务，端口参数化 2000-65535） */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = (() => {
  const raw = process.argv[2] || '8653';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return p;
})();
const ROOT = path.resolve(__dirname, '..', '..');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (rel === 'favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const exeDir = 'C:/Users/Emon/AppData/Local/ms-playwright/chromium-1234';
  const cand = fs.readdirSync(exeDir).find(d => d.startsWith('chrome-win'));
  const b = await chromium.launch({ executablePath: path.join(exeDir, cand || 'chrome-win', 'chrome.exe') });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('JS: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/GitBoard-快速笔记预览.html`, { waitUntil: 'load' });
  const results = [];
  const check = (n, c, d) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

  // A 编辑态默认
  check('A 编辑态：光标/表格选区浮动条显示', await page.evaluate(() => !document.querySelector('.cursor-line')?.classList.contains('cursor-line') === false || !!document.querySelector('.cursor-line')));
  check('A 编辑态：表格合并单元格高亮', await page.evaluate(() => document.querySelectorAll('td.merged.cell-sel').length >= 2));
  check('A 编辑态：合并浮层显示', await page.evaluate(() => [...document.querySelectorAll('.tbl-float')].every(f => !f.classList.contains('hidden'))));
  check('A 画板流程图渲染（节点数≥4）', await page.evaluate(() => document.querySelectorAll('#skSvg .sk-node').length >= 4));
  check('A 卡片样例 2 种', await page.evaluate(() => document.querySelectorAll('.callout').length >= 2));

  // B / 菜单 + 过滤
  await page.click('[data-scene="slash"]');
  check('B / 菜单显示', await page.evaluate(() => !document.getElementById('slashMenu').classList.contains('hidden')));
  check('B 菜单项 ≥ 18', await page.evaluate(() => document.querySelectorAll('#slashList .slash-item').length >= 18));
  await page.fill('#slashInput', '卡片');
  const visCards = await page.evaluate(() => [...document.querySelectorAll('#slashList .slash-item')].filter(i => i.style.display !== 'none').length);
  check('B 过滤「卡片」→ 5 项', visCards === 5, 'got ' + visCards);
  await page.fill('#slashInput', 'todo');
  const visTodo = await page.evaluate(() => [...document.querySelectorAll('#slashList .slash-item')].filter(i => i.style.display !== 'none').length);
  check('B 过滤「todo」→ 1 项', visTodo === 1, 'got ' + visTodo);
  await page.fill('#slashInput', '');

  // C 画板
  await page.click('[data-scene="sketch"]');
  check('C 画板工具条显示', await page.evaluate(() => !document.getElementById('skTools').classList.contains('hidden')));
  check('C 画板边框高亮', await page.evaluate(() => document.getElementById('sketchBox').style.borderColor !== ''));
  await page.click('#skSvg .sk-node');
  check('C 节点点击选中', await page.evaluate(() => document.querySelectorAll('.sk-node.sel').length === 1));

  // D 导出
  await page.click('[data-scene="export"]');
  check('D 导出菜单显示', await page.evaluate(() => !document.getElementById('exportMenu').classList.contains('hidden')));
  check('D 导出 4+1 项', await page.evaluate(() => document.querySelectorAll('#exportMenu .mi').length >= 5));

  // E AI
  await page.click('[data-scene="ai"]');
  check('E AI 浮层 + 差异预览显示', await page.evaluate(() => !document.getElementById('aiPop').classList.contains('hidden') && !document.getElementById('aiResult').classList.contains('hidden')));
  check('E 选区文本存在', await page.evaluate(() => !!document.getElementById('selSpan')));
  await page.click('.ai-result .ops .pv-btn');   // 接受替换
  check('E 接受替换后选区消失、正文更新', await page.evaluate(() => !document.getElementById('selSpan') && document.querySelector('.doc p').textContent.includes('三项结论')));

  // 大纲联动 / 视图切换 / 主题
  await page.click('.ol-item.ol-3');
  check('大纲点击 → 对应标题高亮动画', await page.evaluate(() => {
    const el = document.getElementById('h-4');
    return el.getAnimations().length > 0 || Math.abs(el.getBoundingClientRect().top) < 200;
  }));
  await page.click('#vList');
  check('文件列表切列表视图', await page.evaluate(() => !document.getElementById('noteList').classList.contains('grid')));
  await page.click('#vGrid');
  check('切回图标视图', await page.evaluate(() => document.getElementById('noteList').classList.contains('grid')));
  await page.click('#themeBtn');
  check('浅色主题切换', await page.evaluate(() => document.body.classList.contains('light')));
  await page.screenshot({ path: '.playwright-mcp/notes-preview-light.png', fullPage: false });
  await page.click('#themeBtn');

  check('无 JS/控制台错误', errors.length === 0, errors.slice(0, 3).join(' ; '));
  const fails = results.filter(r => !r).length;
  console.log(fails ? 'NOTES-PREVIEW FAIL x' + fails : 'NOTES-PREVIEW ALL-PASS');
  await b.close();
  server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
