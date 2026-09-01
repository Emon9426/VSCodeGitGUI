/**
 * 快速笔记（v0.15.0）通信协议——与主面板 protocol.ts 完全独立，零 git 依赖。
 * 请求-响应复用主面板同款自增 id 信封（webview 侧 rpc.ts 直接复用）。
 */

/** 背景色卡片种类（Confluence 式预制） */
export type CalloutKind = 'info' | 'ok' | 'warn' | 'danger' | 'note';

/** 文件列表条目（不含 doc，按需加载） */
export interface NoteMeta {
  id: string;          // 文件名（不含扩展名）
  title: string;       // 显示标题（存于文件元数据）
  updated: number;     // mtime ms
  created: number;
}

export interface NoteFile {
  meta: NoteMeta;
  doc: unknown;        // TipTap/ProseMirror 文档 JSON（唯一权威数据）
  /** 文档背景（v0.16；旧文件 = 默认护眼黄） */
  bg?: NoteBg;
}

/** 文档背景（v0.16）：颜色 + 图案；缺省 = 护眼黄、无图案 */
export interface NoteBg { color: string; pattern: 'none' | 'grid' | 'line' }

export const DEFAULT_NOTE_BG: NoteBg = { color: '#FAF9DE', pattern: 'none' };

/** 存储格式（.gbnote.json） */
export interface NoteDoc {
  version: 1;
  title: string;
  created: string;     // ISO
  updated: string;     // ISO
  doc: unknown;
  /** 文档背景（v0.16）；旧文件无此字段 = 默认护眼黄 */
  bg?: NoteBg;
}

/** 导出格式 */
export type ExportFmt = 'md' | 'html' | 'pdf';

/** Webview → 宿主 全部命令 */
export type NotesCommand =
  | 'notes.list'
  | 'notes.read'        // { id } -> NoteFile
  | 'notes.create'      // { title? } -> NoteMeta
  | 'notes.rename'      // { id, title } -> NoteMeta
  | 'notes.delete'      // { id }
  | 'notes.save'        // { id, doc, title, bg? } -> { savedAt }
  | 'notes.setDir'      // { dir } -> { dir }
  | 'notes.pickDir'     // {} -> { dir } | null（系统对话框）
  | 'notes.export'      // { id, doc, title, fmt, htmlBody?, bg? } -> { path } | { fallback: true }
  | 'notes.saveAs'      // { id, doc, title, fmt, htmlBody?, bg? } -> { path } | null
  | 'notes.revealInFM'  // { id }
  | 'notes.pickImage'   // {} -> { dataUrl, name } | null（系统对话框选图，读为 data URL 内嵌）
  | 'notes.setDefFont'  // { script: 'zh' | 'en', family } -> { zh, en }（默认字体，中英分设）
  | 'notes.ai'          // { action, text, custom? }（流式 aiChunk；响应用到全部文本）
  | 'notes.aiCancel';   // {}

/** 宿主 → Webview 事件 */
export type NotesEvent =
  | { t: 'notesReady'; dir: string; notes: NoteMeta[]; language: string; version: string;
      /** 默认字体（中/英分设，globalState 记忆） */
      fontZh?: string; fontEn?: string }
  | { t: 'notesList'; notes: NoteMeta[] }
  | { t: 'dirChanged'; dir: string }
  | { t: 'saved'; id: string; at: number }
  /** 命令直达定位：面板存活期间再次指定打开某篇笔记 */
  | { t: 'openNote'; id: string }
  /** 往返导入：以未落盘草稿形态载入导出的 HTML 数据 */
  | { t: 'importNote'; title: string; doc: unknown }
  | { t: 'notify'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'aiChunk'; text: string }
  | { t: 'aiDone'; text: string }
  | { t: 'aiError'; message: string };

/** 请求响应信封（与主面板同款，webview 侧 rpc.ts 复用） */
export interface NotesResponse {
  t: 'res';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 打开时定位：load id（命令直达）或导入的 HTML 内容 */
export interface NotesOpenOpts {
  loadId?: string;
  importHtml?: { title: string; doc: unknown };
}
