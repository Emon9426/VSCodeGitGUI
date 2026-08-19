/**
 * 将 res/*.svg 渲染为 res/*.png（README 引用 PNG：
 * VS Code Marketplace 禁止 README 使用 SVG 图片；SVG 保留为可编辑源文件）。
 * npm run assets
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async () => {
  const dir = path.join(__dirname, 'res');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.svg'));
  for (const f of files) {
    const src = path.join(dir, f);
    const out = path.join(dir, f.replace(/\.svg$/, '.png'));
    // density 216 ≈ 3x（920 宽的 SVG → 2760px 位图，高分屏清晰）
    await sharp(src, { density: 216 }).png().toFile(out);
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`${f} -> ${path.basename(out)} (${kb} KB)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
