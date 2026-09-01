/**
 * doc JSON → Markdown 导出（v0.15.0）：纯 JSON 树遍历，零 TipTap 依赖（宿主端 bundle 零增量）。
 * 降级规则（方案 §7）：合并单元格拆平、嵌套表格压平、卡片 → blockquote+emoji、
 * 字体/字号/颜色 mark 移除、画板 → SVG 占位引用（由调用方提供 href 或省略）。
 */

interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const CALLOUT_META: Record<string, { emoji: string; label: string }> = {
  info: { emoji: 'ℹ️', label: '信息' },
  ok: { emoji: '✅', label: '成功' },
  warn: { emoji: '⚠️', label: '警告' },
  danger: { emoji: '⛔', label: '危险' },
  note: { emoji: '📝', label: '笔记' },
};

function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

function inlineText(node: PmNode): string {
  if (node.type === 'text') {
    let s = escapeText(node.text ?? '');
    const marks = node.marks ?? [];
    for (const m of marks) {
      if (m.type === 'bold') s = `**${s}**`;
      else if (m.type === 'italic') s = `*${s}*`;
      else if (m.type === 'strike') s = `~~${s}~~`;
      else if (m.type === 'code') s = `\`${node.text ?? ''}\``;   // 行内代码不加其他修饰
    }
    return s;
  }
  if (node.type === 'hardBreak') return '  \n';
  // 其他 inline（图片等暂无）
  return (node.content ?? []).map(inlineText).join('');
}

function isListBlock(n: PmNode): boolean {
  return n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList';
}

/** 列表递归输出 */
function renderList(node: PmNode, indent: string): string {
  const lines: string[] = [];
  let idx = 1;
  // 列表项内容：首行顶格（缩进交给列表标记本身），续行保留子级缩进（嵌套列表）
  const inner = (item: PmNode, childIndent: string): string => {
    const s = (item.content ?? []).map(c => blockLines(c, childIndent).join('\n')).filter(Boolean).join('\n');
    return s.replace(/^\s+/, '');
  };
  for (const item of node.content ?? []) {
    if (node.type === 'taskList') {
      const checked = !!item.attrs?.checked;
      lines.push(`${indent}- [${checked ? 'x' : ' '}] ${inner(item, indent + '  ')}`.trimEnd());
    } else if (node.type === 'orderedList') {
      lines.push(`${indent}${idx++}. ${inner(item, indent + '   ')}`.trimEnd());
    } else {
      lines.push(`${indent}- ${inner(item, indent + '  ')}`.trimEnd());
    }
  }
  return lines.join('\n');
}

/** 压平嵌套表格为缩进列表（降级） */
function flattenNestedTable(table: PmNode, indent: string): string {
  const lines: string[] = [];
  for (const row of table.content ?? []) {
    for (const cell of row.content ?? []) {
      const inner = (cell.content ?? []).map(c => blockLines(c, indent + '  ').join('\n')).filter(Boolean).join('\n');
      lines.push(`${indent}- ${inner.trim() || ' '}`);
    }
  }
  return lines.join('\n');
}

/** 单个块级节点 → 多行文本（不含尾随空行） */
function blockLines(node: PmNode, indent = ''): string[] {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(4, Number(node.attrs?.level) || 1);
      const text = (node.content ?? []).map(inlineText).join('');
      return [`${indent}${'#'.repeat(level)} ${text}`];
    }
    case 'paragraph':
      return [indent + (node.content ?? []).map(inlineText).join('')];
    case 'blockquote':
      return (node.content ?? []).flatMap(c => blockLines(c, indent)).map(l => `${indent}> ${l.slice(indent.length)}`);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return renderList(node, indent).split('\n');
    case 'codeBlock': {
      const lang = String(node.attrs?.language ?? '') || '';
      const code = (node.content ?? []).map(c => c.text ?? '').join('');
      return [`${indent}\`\`\`${lang}`, ...code.split('\n').map(l => indent + l), `${indent}\`\`\``];
    }
    case 'horizontalRule':
      return [`${indent}---`];
    case 'callout': {
      const kind = String(node.attrs?.kind ?? 'note');
      const meta = CALLOUT_META[kind] ?? CALLOUT_META.note;
      const title = String(node.attrs?.title ?? '');
      const body = (node.content ?? []).flatMap(c => blockLines(c, indent)).join('\n');
      const head = `${indent}> ${meta.emoji} **${title || meta.label}**`;
      const lines = body.split('\n').map(l => `${indent}> ${l.slice(indent.length)}`);
      return [head, ...lines];
    }
    case 'sketch': {
      const href = typeof node.attrs?.href === 'string' ? node.attrs.href : '';
      const alt = String(node.attrs?.title ?? 'sketch');
      return [href ? `${indent}![${alt}](${href})` : `${indent}<!-- sketch "${alt}" removed in markdown export -->`];
    }
    case 'gbImage': {
      // v0.17：正文图片 → Markdown 图片（data URL 内嵌，单文件自包含）
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const alt = String(node.attrs?.alt ?? 'image');
      return [src ? `${indent}![${alt.replace(/[[\]]/g, '')}](${src})` : `${indent}<!-- image missing -->`];
    }
    case 'table':
      return renderTable(node, indent).split('\n');
    case 'headingPlaceholder':
    case 'text':
      return [indent + inlineText(node)];
    default:
      // 未知块：递归内容兜底
      return (node.content ?? []).flatMap(c => blockLines(c, indent));
  }
}

/** GFM 管道表。合并单元格拆平：内容放入首个被覆盖位置，其余置空。 */
function renderTable(table: PmNode, indent: string): string {
  const rows = table.content ?? [];
  const grid: string[][] = [];
  for (const row of rows) {
    const cells = row.content ?? [];
    const line: string[] = [];
    for (const cell of cells) {
      const inner = (cell.content ?? []).map(c => {
        if (c.type === 'table') return flattenNestedTable(c, '').replace(/\n/g, ' / ');   // 嵌套表格压平单行
        return blockLines(c).join(' ');
      }).join(' ').replace(/\|/g, '\\|').trim() || ' ';
      const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
      line.push(inner);
      for (let i = 1; i < colspan; i++) line.push(' ');   // 合并降级：占位空列
    }
    grid.push(line);
  }
  if (!grid.length) return '';
  const width = Math.max(...grid.map(r => r.length));
  for (const r of grid) while (r.length < width) r.push(' ');
  const header = grid[0];
  const rest = grid.slice(1);
  const mk = (r: string[]) => `${indent}| ${r.join(' | ')} |`;
  const sep = `${indent}|${Array.from({ length: width }, () => ' --- ').join('|')}|`;
  const headIsTh = rows[0]?.content?.[0]?.type === 'tableHeader';
  const out: string[] = [];
  if (headIsTh) {
    out.push(mk(header), sep, ...rest.map(mk));
  } else {
    out.push(mk(Array.from({ length: width }, () => ' ')), sep, ...grid.map(mk));
  }
  return out.join('\n');
}

/** 入口：doc → Markdown 文本（块内行紧凑，块间空一行） */
export function docToMarkdown(doc: PmNode, opts?: { sketchHrefOf?: (title: string) => string | undefined }): string {
  // 深拷贝后原地回写 sketch href（避免共享/父引用问题）
  const clone = JSON.parse(JSON.stringify(doc)) as PmNode;
  const walk = (n: PmNode): void => {
    if (n.type === 'sketch' && opts?.sketchHrefOf) {
      n.attrs = { ...n.attrs, href: opts.sketchHrefOf(String(n.attrs?.title ?? 'sketch')) };
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(clone);
  const blocks = (clone.content ?? []).map(c => blockLines(c).filter(l => l.trim().length || l.startsWith('>') || l === '---').join('\n')).filter(Boolean);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
