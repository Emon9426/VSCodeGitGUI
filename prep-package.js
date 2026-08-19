/**
 * 打包前置：生成 .vscode-readme.md（vsix 内使用的去图版）。
 * 原因：vsce 在 package.json 无 repository 时会拒绝 README 中的相对图片与 data URI
 * （只接受绝对 http 链接）。仓库根目录的 README.md 保持完整图文版；
 * 打包版移除图片行并在顶部附指引说明。
 */
const fs = require('fs');

const src = fs.readFileSync('README.md', 'utf8');
let stripped = src.replace(/!\[[^\]]*\]\(res\/[^)]+\)\n?/g, '');
stripped = stripped.replace(/\[([^\]]+)\]\(\.?\/?LICENSE\)/g, '$1（见 LICENSE 文件 / see the LICENSE file）');
const note = '> 📖 本文件为文本版；界面示意图与完整排版见仓库根目录的 README.md。\n'
  + '> This is the text-only copy; see README.md at the repository root for the fully illustrated version.\n\n';
fs.writeFileSync('.vscode-readme.md', note + stripped);
console.log('prep-package: generated text-only .vscode-readme.md');
