const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** 扩展宿主侧：cjs，external vscode */
const ext = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  logLevel: 'info',
};

/** Webview 前端：iife 单文件（CSS 输出为 out/webview.css，由 panel 内联注入） */
const ui = {
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  outfile: 'out/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctxExt = await esbuild.context(ext);
    const ctxUi = await esbuild.context(ui);
    await Promise.all([ctxExt.watch(), ctxUi.watch()]);
  } else {
    await esbuild.build(ext);
    await esbuild.build(ui);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
