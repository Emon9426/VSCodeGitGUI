/**
 * 自包含 HTML 导出（v0.15.0）：内联样式（阅读态视觉与编辑器一致）+ 内嵌完整 doc JSON 数据块。
 * 浏览器直接打开 = 纯阅读（数据块被忽略）；插件内打开 = parseNoteHtml 检测数据块还原编辑。
 * htmlBody 由 webview 端 TipTap getHTML() 生成（宿主不引入 TipTap，bundle 零增量）。
 */
import { NOTE_DATA_TAG } from './notesStore';
import { DEFAULT_NOTE_BG, type NoteBg, type NoteDoc } from '../common/notesProtocol';

const READ_CSS = `
  body { margin: 0 auto; max-width: 860px; padding: 40px 28px 80px; color: #1f2328;
    font: 15px/1.75 "Segoe UI","Microsoft YaHei",sans-serif; background: #fff; }
  h1 { font-size: 26px; } h2 { font-size: 20px; border-bottom: 1px solid #e1e4e8; padding-bottom: 4px; }
  h3 { font-size: 17px; } h4 { font-size: 15px; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 8px; padding: 12px 14px;
    overflow: auto; font: 13px/1.6 Consolas,monospace; }
  code { background: #f6f8fa; padding: 1px 6px; border-radius: 4px; font: 13px Consolas,monospace; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10px 0; padding: 4px 16px; border-left: 3px solid #9aa4ae; color: #57606a;
    background: #f6f8fa; border-radius: 0 6px 6px 0; }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
  th { background: #f6f8fa; }
  ul.todo-list { list-style: none; padding-left: 6px; }
  ul.todo-list li { margin: 4px 0; }
  ul.todo-list li[data-checked="true"] { color: #6a737d; text-decoration: line-through; }
  .gg-callout { border: 1px solid; border-left-width: 4px; border-radius: 8px; padding: 10px 16px; margin: 12px 0; }
  .gg-callout .gg-callout-title { font-weight: 700; margin-bottom: 2px; }
  .gg-callout.info { background: #ddf4ff; border-color: #0969da; } .gg-callout.info .gg-callout-title { color: #0550ae; }
  .gg-callout.ok { background: #dafbe1; border-color: #1a7f37; } .gg-callout.ok .gg-callout-title { color: #116329; }
  .gg-callout.warn { background: #fff8c5; border-color: #d4a72c; } .gg-callout.warn .gg-callout-title { color: #7d6608; }
  .gg-callout.danger { background: #ffebe9; border-color: #cf222e; } .gg-callout.danger .gg-callout-title { color: #a40e26; }
  .gg-callout.note { background: #f6f8fa; border-color: #8c959f; } .gg-callout.note .gg-callout-title { color: #57606a; }
  .gg-sketch { border: 1px solid #d0d7de; border-radius: 8px; margin: 12px 0; background: #fff; }
  .gg-sketch svg { display: block; width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #e1e4e8; margin: 20px 0; }
  .gg-meta { color: #8c959f; font-size: 12px; margin-top: 48px; }
`;

function escapeScriptClose(json: string): string {
  // 防止数据内容中出现 </script> 提前闭合数据块
  return json.replace(/<\//g, '<\\/');
}

/** 组装自包含 HTML（htmlBody = webview 端 getHTML() 输出；bg = 文档背景随导出同步） */
export function buildExportHtml(title: string, doc: unknown, htmlBody: string, updatedIso: string, bg?: NoteBg): string {
  const b = bg ?? DEFAULT_NOTE_BG;
  const bodyStyle = `background:${b.color}` +
    (b.pattern === 'grid'
      ? `;background-image:linear-gradient(#00000010 1px,transparent 1px),linear-gradient(90deg,#00000010 1px,transparent 1px);background-size:24px 24px`
      : b.pattern === 'line'
        ? `;background-image:repeating-linear-gradient(transparent 0 27px,#00000012 27px 28px)`
        : '');
  const data = JSON.stringify({ gitboardNote: 1, version: 1, title, doc, bg: b } satisfies { gitboardNote: number; version: number; title: string; doc: unknown; bg: NoteBg } & Partial<NoteDoc>);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${READ_CSS}</style>
</head>
<body style="${bodyStyle}">
${htmlBody}
<div class="gg-meta">Exported by GitBoard Quick Notes · ${escapeHtml(updatedIso)}</div>
<script type="application/json" id="${NOTE_DATA_TAG}">${escapeScriptClose(data)}</script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
