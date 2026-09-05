/**
 * 内联 SVG 图标库（16 viewBox / stroke 描边 / currentColor 跟随主题）。
 * 替代此前的 Unicode 字符按钮（⬇⬆↗⇄⧉📂 等）——「全部暂存 ⬇ / 取消暂存 ⬆」
 * 与语义无对应关系，改为清单勾选/清单空框，直接呼应"勾选即暂存"交互。
 */
const NS = 'http://www.w3.org/2000/svg';

/** 每个图标 = 若干 path 的 d 序列 */
const PATHS: Record<string, readonly string[]> = {
  /** 全部暂存：三行清单全勾选 */
  checklist: [
    'M1.8 3.4l1.3 1.3 2.5-2.7', 'M7.6 3.5h6.6',
    'M1.8 8.2l1.3 1.3 2.5-2.7', 'M7.6 8.3h6.6',
    'M1.8 13l1.3 1.3 2.5-2.7', 'M7.6 13.1h6.6',
  ],
  /** 全部取消暂存：三行清单全空框 */
  checklistEmpty: [
    'M1.7 1.7h3.4v3.4H1.7z', 'M7.6 3.4h6.6',
    'M1.7 6.6h3.4V10H1.7z', 'M7.6 8.3h6.6',
    'M1.7 11.5h3.4v3.4H1.7z', 'M7.6 13.2h6.6',
  ],
  /** 删除文件：回收站 */
  trash: [
    'M2.3 3.2h11.4', 'M6.3 3.2V1.8h3.4v1.4',
    'M4 3.2l.7 10.6q.05.9.95.9h4.7q.9 0 .95-.9L12 3.2',
    'M6.6 6v4.6', 'M9.4 6v4.6',
  ],
  /** 上一个/下一个文件 */
  chevronLeft: ['M9.8 2.8L5.6 8l4.2 5.2'],
  chevronRight: ['M6.2 2.8L10.4 8l-4.2 5.2'],
  /** 打开文件：文档 + 出框箭头 */
  goToFile: ['M2.2 2h5.6', 'M2.2 2v12h7.6V9.4', 'M7.6 8.4L14 2', 'M9.8 2H14v4.2'],
  /** 原生 diff 编辑器：两页对比 */
  compare: ['M6 1.8h8.2v9.2H6', 'M2 5.2h8.2v9.2H2z'],
  /** 复制路径：叠放两页 */
  copy: ['M5.4 1.8H14v8.8h-3.8', 'M2 5.2h8.6V14.4H2z'],
  /** 复制文件名：文档框 + 文件名横线 */
  copyName: ['M3.2 1.8h9.6v12.4H3.2z', 'M5.6 8h4.8'],
  /** 刷新文件状态：圆弧箭头 */
  refresh: ['M13.2 8a5.2 5.2 0 1 1-1.52-3.68', 'M13.6 1.6v3h-3'],
  /** 在文件管理器中定位：文件夹 */
  folder: ['M1.6 13.6V2.8h4.4l1.6 2h6.8v8.8z'],
  /** 清理 Office 临时文件（~$…）：扫帚 */
  broom: [
    'M10.3 1.7L6.2 5.8',                       // 柄
    'M4.6 6.6h4.2l1.6 6.2H2.8z',                // 刷体（梯形）
    'M4.6 14.4l-.4 1.2', 'M6.9 14.6l.1 1.2', 'M9.2 14.3l.5 1.2',   // 扫毛
  ],
  // ---------- 通知/横幅语义图标（Issue #18 S2/S3） ----------
  /** 信息：圆 + i */
  info: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z', 'M8 7.2v4.2', 'M8 4.3v.2'],
  /** 成功：圆 + 对勾 */
  checkCircle: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z', 'M5.2 8.2l1.9 1.9 3.8-4.2'],
  /** 警告：三角 + 感叹 */
  warnTriangle: ['M8 2.3 14.3 13H1.7z', 'M8 6.3v3.2', 'M8 11.2v.2'],
  /** 错误：圆 + 叉 */
  errorX: ['M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z', 'M5.7 5.7l4.6 4.6', 'M10.3 5.7l-4.6 4.6'],
  /** 推送：上箭头 + 托盘 */
  pushUp: ['M8 10.8V3', 'M4.7 6.3 8 3l3.3 3.3', 'M2.6 12.6h10.8'],
  /** 移动/搬运：箭头入位 + 底线 */
  movePath: ['M8 11.4V3.2', 'M4.6 6.6 8 3.2l3.4 3.4', 'M2.4 13.4h11.2'],
};

export type IconName = keyof typeof PATHS;

/** 构造图标元素（append 到按钮内即可，尺寸由 CSS .gg-ic 控制） */
export function iconSvg(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.classList.add('gg-ic');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** 用图标替换按钮内容（按钮原文字清空） */
export function setIcon(btn: HTMLElement, name: IconName): void {
  btn.textContent = '';
  btn.appendChild(iconSvg(name));
}

// ---------- 文件类型图标（v0.14 文件历史页） ----------

/** 类型映射：扩展名 → 缩写文字 + 类型色（深浅主题共用色值，浅色下由透明度自适应视觉重量） */
const FILE_TYPES: { exts: string[]; label: string; color: string; type: string }[] = [
  { exts: ['md', 'markdown'], label: 'M↓', color: '#519aba', type: 'Markdown' },
  { exts: ['ts', 'tsx'], label: 'TS', color: '#519aba', type: 'TypeScript' },
  { exts: ['js', 'jsx', 'mjs', 'cjs'], label: 'JS', color: '#cbcb41', type: 'JavaScript' },
  { exts: ['json'], label: '{}', color: '#cbcb41', type: 'JSON' },
  { exts: ['html', 'htm'], label: '<>', color: '#e37933', type: 'HTML' },
  { exts: ['css', 'scss', 'less'], label: '#', color: '#519aba', type: 'CSS' },
  { exts: ['vue'], label: 'V', color: '#41b883', type: 'Vue' },
  { exts: ['py'], label: 'PY', color: '#3572a5', type: 'Python' },
  { exts: ['java'], label: 'J', color: '#b07219', type: 'Java' },
  { exts: ['go'], label: 'GO', color: '#00add8', type: 'Go' },
  { exts: ['c', 'h', 'cpp', 'hpp'], label: 'C', color: '#555555', type: 'C/C++' },
  { exts: ['cs'], label: 'C#', color: '#178600', type: 'C#' },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico'], label: '🖼', color: '#a074c4', type: 'Image' },
  { exts: ['svg'], label: 'SVG', color: '#ffb13b', type: 'SVG' },
  { exts: ['pdf'], label: 'PDF', color: '#cc3e44', type: 'PDF' },
  { exts: ['xlsx', 'xls', 'csv'], label: 'XLS', color: '#8dc149', type: 'Excel' },
  { exts: ['docx', 'doc'], label: 'DOC', color: '#519aba', type: 'Word' },
  { exts: ['pptx', 'ppt'], label: 'PPT', color: '#cc3e44', type: 'PowerPoint' },
  { exts: ['zip', 'rar', '7z', 'gz', 'tar'], label: 'ZIP', color: '#6d8086', type: 'Archive' },
  { exts: ['txt', 'log'], label: 'TXT', color: '#cccccc', type: 'Text' },
  { exts: ['yml', 'yaml'], label: 'YML', color: '#cb171e', type: 'YAML' },
  { exts: ['xml'], label: 'XML', color: '#e37933', type: 'XML' },
];

const FALLBACK_TYPE = { label: 'DOC', color: '#8b949e', type: 'File' };

export function fileTypeInfo(fileName: string): { label: string; color: string; type: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return { label: 'TXT', color: '#cccccc', type: 'File' };
  const ext = fileName.slice(dot + 1).toLowerCase();
  return FILE_TYPES.find(f => f.exts.includes(ext)) ?? FALLBACK_TYPE;
}

/** 构造文件/文件夹类型图标：文档基形 + 类型缩写（彩色）；文件夹为填充形 */
export function fileIconSvg(fileName: string, isDir: boolean, size = 16): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.classList.add('gg-fileic');
  if (size !== 16) svg.style.width = svg.style.height = size + 'px';
  if (isDir) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M1.5 13.5V2.8h4.5l1.7 2h6.8v8.7z');
    p.setAttribute('fill', '#dcb67a');
    svg.appendChild(p);
    return svg;
  }
  const info = fileTypeInfo(fileName);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M3.2 1.5h6l3.6 3.6v9.4H3.2z');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', info.color);
  p.setAttribute('stroke-width', '1.1');
  svg.appendChild(p);
  const fold = document.createElementNS(NS, 'path');
  fold.setAttribute('d', 'M9 1.7v3.4h3.6');
  fold.setAttribute('fill', 'none');
  fold.setAttribute('stroke', info.color);
  fold.setAttribute('stroke-width', '1.1');
  svg.appendChild(fold);
  if (info.label.length <= 3) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '8');
    t.setAttribute('y', '11.2');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', info.label.length >= 3 ? '4.2' : '5.5');
    t.setAttribute('font-weight', '700');
    t.setAttribute('font-family', 'Segoe UI, sans-serif');
    t.setAttribute('fill', info.color);
    t.textContent = info.label;
    svg.appendChild(t);
  }
  return svg;
}
