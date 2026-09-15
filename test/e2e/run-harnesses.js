/** 批量运行 test/e2e/*.html harness（document.title = 'e2e:PASS|FAIL' 报告） */
const { chromium } = require('playwright-core');
const path = require('path');

(async () => {
  const exeDir = 'C:/Users/Emon/AppData/Local/ms-playwright/chromium-1234';
  const fs = require('fs');
  const cand = fs.readdirSync(exeDir).find(d => d.startsWith('chrome-win'));
  const exe = path.join(exeDir, cand || 'chrome-win', 'chrome.exe');
  const b = await chromium.launch({ executablePath: exe });
  const page = await b.newPage();
  const list = ['harness.html', 'harness-boot.html', 'harness-detail.html', 'harness-files.html', 'harness-lanes.html',
    'harness-op.html', 'harness-v11.html', 'harness-v13.html', 'harness-diag.html',
    // Issue #51/#52/#53：Pull 摘要表格化+历史 / 作者过滤 lane 泄漏 / ref 徽标省略号
    // Issue #55：工作副本目录头 Checkbox 文件夹级全选
    // Issue #59/#60/#61：工具栏 PR/历史按钮 + 文件页双击回退
    'harness-psum-table.html', 'harness-author-filter.html', 'harness-chip-ellipsis.html', 'harness-work-dircheck.html', 'harness-prbtn-hist-dblclick.html'];
  let fails = 0;
  for (const h of list) {
    try {
      await page.goto('http://127.0.0.1:8917/test/e2e/' + h, { waitUntil: 'load', timeout: 15000 });
      await page.waitForFunction(() => /-e2e:/.test(document.title) || document.title.startsWith('e2e:'), null, { timeout: 30000 });
      const t = await page.title();
      console.log(h, '=>', t.slice(4).slice(0, 120));
      // harness-detail/v13 以 'DONE' 表示通过，其余用 'PASS'
      if (!/PASS|^.{0,4}e2e:DONE|:DONE/.test(t)) fails++;
    } catch (e) { console.log(h, '=> ERROR', e.message.slice(0, 80)); fails++; }
  }
  await b.close();
  console.log(fails ? 'HARNESS-FAIL x' + fails : 'HARNESS-ALL-PASS');
  process.exit(fails ? 1 : 0);
})();
