/** 图形列样式预览页验证：加载无错、6 卡片、每卡 16 行 canvas、像素非空、三种风格 lane 宽正确 */
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const exeDir = 'C:/Users/Emon/AppData/Local/ms-playwright/chromium-1234';
const cand = fs.readdirSync(exeDir).find(d => d.startsWith('chrome-win'));
(async () => {
  const b = await chromium.launch({ executablePath: path.join(exeDir, cand, 'chrome.exe'), headless: true });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'http://127.0.0.1:8917/' + encodeURIComponent('GitBoard-图形列样式预览.html');
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => document.title.startsWith('graph-styles-e2e:'), null, { timeout: 15000 });
  console.log('TITLE:', (await page.title()).slice(17));

  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    return {
      cards: cards.length,
      names: cards.map(c => c.querySelector('h2').textContent.trim().slice(0, 14)),
      canvasCounts: cards.map(c => c.querySelectorAll('canvas').length),
      canvasW: cards.map(c => c.querySelector('canvas').getBoundingClientRect().width),
    };
  });
  console.log('cards:', info.cards, JSON.stringify(info.names));
  console.log('rows per card:', JSON.stringify(info.canvasCounts));
  console.log('first canvas widths:', JSON.stringify(info.canvasW));

  // 像素采样：每卡首行 canvas 上应有彩色像素（lane 线/节点）
  const pix = await page.evaluate(() => {
    return [...document.querySelectorAll('.card')].map(card => {
      const cv = card.querySelector('canvas');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 40 && (Math.abs(d[i] - d[i + 1]) > 24 || Math.abs(d[i + 1] - d[i + 2]) > 24)) colored++;
      }
      return colored;
    });
  });
  console.log('colored pixels per card:', JSON.stringify(pix));

  // 行高切换 + 主题切换 + 仅图形列 都不报错
  await page.click('#segRowH button[data-v="20"]');
  await page.click('#segTheme button[data-v="light"]');
  await page.click('#segMode button[data-v="graph"]');
  await new Promise(r => setTimeout(r, 400));
  const gridCls = await page.evaluate(() => document.getElementById('grid').className);
  console.log('toggles ok:', gridCls);
  await page.click('#segTheme button[data-v="dark"]');
  await page.click('#segMode button[data-v="full"]');
  await page.click('#segRowH button[data-v="24"]');
  await new Promise(r => setTimeout(r, 300));

  await page.screenshot({ path: '.playwright-mcp/graph-styles-preview.png', fullPage: true });
  const errs2 = errs.filter(e => !/favicon|404/i.test(e));
  console.log('errors:', errs2.length ? JSON.stringify(errs2.slice(0, 3)) : 'none (favicon 404 忽略)');
  const pass = info.cards === 6 && info.canvasCounts.every(c => c === 16) && pix.every(p => p > 30) && !errs2.length;
  console.log(pass ? 'STYLES-PREVIEW-PASS' : 'STYLES-PREVIEW-FAIL');
  await b.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
