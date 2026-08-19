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
  // 扩展市场图标：必须为 128×128 PNG（高密度渲染后缩到 128 保证平滑）
  const iconSrc = path.join(__dirname, 'media', 'icon.svg');
  const iconOut = path.join(__dirname, 'media', 'icon.png');
  await sharp(iconSrc, { density: 288 }).resize(128, 128, { kernel: 'lanczos3' }).png().toFile(iconOut);
  console.log(`media/icon.svg -> media/icon.png (${(fs.statSync(iconOut).size / 1024).toFixed(1)} KB, 128×128)`);
})().catch(e => { console.error(e); process.exit(1); });
