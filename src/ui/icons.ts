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
  /** 在文件管理器中定位：文件夹 */
  folder: ['M1.6 13.6V2.8h4.4l1.6 2h6.8v8.8z'],
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
