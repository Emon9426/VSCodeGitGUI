/**
 * 快速笔记存储（v0.15.0）：目录管理、文件 CRUD、搜索——纯 fs，零 git 依赖。
 * 原生格式 .gbnote.json（NoteDoc：元数据 + ProseMirror doc JSON 唯一权威数据）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { DEFAULT_NOTE_BG, type NoteBg, type NoteDoc, type NoteFile, type NoteMeta } from '../common/notesProtocol';

export const NOTE_EXT = '.gbnote.json';

export function defaultNotesDir(): string {
  return path.join(os.homedir(), 'GitBoardNotes');
}

/** 文件名 slug 化：剔除路径分隔符/元字符，限长 60。id 必须是 slugify 恒等形态。 */
export function slugify(title: string): string {
  const s = title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'note';
}

/** id（目录内唯一）→ 绝对路径。三层防御：slug 白名单恒等校验 + resolve 边界 + dirname 必须为根。 */
export function notePath(dir: string, id: string): string {
  if (!id || id.startsWith('.')) throw new Error('invalid note id');
  if (slugify(id) !== id) throw new Error('invalid note id');   // 恒等于 slug ⇒ 不含分隔符 / '..' / 元字符
  const root = path.resolve(dir);
  const target = path.resolve(root, id + NOTE_EXT);
  if (!target.startsWith(root + path.sep)) throw new Error('note path escapes notes dir');
  if (path.dirname(target) !== root) throw new Error('invalid note id');
  return target;
}

function readDoc(file: string): NoteDoc | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const d = JSON.parse(raw) as NoteDoc;
    if (!d || typeof d !== 'object' || !('doc' in d)) return undefined;
    return d;
  } catch {
    return undefined;
  }
}

/** 列出目录全部笔记（修改时间倒序）。目录不存在时自动创建并返回空。 */
export function listNotes(dir: string): NoteMeta[] {
  fs.mkdirSync(dir, { recursive: true });
  const out: NoteMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(NOTE_EXT)) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    const d = readDoc(file);
    out.push({
      id: name.slice(0, -NOTE_EXT.length),
      title: d?.title || name.slice(0, -NOTE_EXT.length),
      updated: st.mtimeMs,
      created: st.birthtimeMs,
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

export function readNote(dir: string, id: string): NoteFile {
  const file = notePath(dir, id);
  const d = readDoc(file);
  if (!d) throw new Error(`cannot read note: ${id}`);
  const st = fs.statSync(file);
  return {
    meta: { id, title: d.title || id, updated: st.mtimeMs, created: st.birthtimeMs },
    doc: d.doc,
    bg: normalizeBg(d.bg),
  };
}

/** 旧文件无 bg → 默认护眼黄；非法值兜底 */
export function normalizeBg(bg?: NoteBg): NoteBg {
  if (!bg || typeof bg.color !== 'string') return { ...DEFAULT_NOTE_BG };
  const pattern = bg.pattern === 'grid' || bg.pattern === 'line' ? bg.pattern : 'none';
  return { color: bg.color, pattern };
}

/** 同名去重：title.gbnote.json / title-2 / title-3 … */
export function uniqueId(dir: string, title: string): string {
  const base = slugify(title);
  let id = base;
  for (let i = 2; fs.existsSync(notePath(dir, id)); i++) id = `${base}-${i}`;
  return id;
}

export function createNote(dir: string, title: string, doc?: unknown): NoteMeta {
  fs.mkdirSync(dir, { recursive: true });
  const id = uniqueId(dir, title);
  const now = new Date().toISOString();
  const d: NoteDoc = {
    version: 1,
    title,
    created: now,
    updated: now,
    doc: doc ?? {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }, { type: 'paragraph' }],
    },
  };
  fs.writeFileSync(notePath(dir, id), JSON.stringify(d, null, 2), 'utf8');
  const st = fs.statSync(notePath(dir, id));
  return { id, title, updated: st.mtimeMs, created: st.birthtimeMs };
}

/** 保存（写入 updated 与 title 与 bg；返回保存时刻） */
export function saveNote(dir: string, id: string, doc: unknown, title: string, bg?: NoteBg): number {
  const file = notePath(dir, id);
  const prev = readDoc(file);
  const d: NoteDoc = {
    version: 1,
    title: title || prev?.title || id,
    created: prev?.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    doc,
    bg: normalizeBg(bg ?? prev?.bg),
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
  return Date.now();
}

/** 重命名 = 磁盘改名 + 元数据 title 更新；目标重名时自动去重 */
export function renameNote(dir: string, id: string, title: string): NoteMeta {
  const file = notePath(dir, id);
  const d = readDoc(file);
  if (!d) throw new Error(`cannot read note: ${id}`);
  const newId = id === slugify(title) ? id : uniqueId(dir, title);
  const target = notePath(dir, newId);
  d.title = title || d.title;
  d.updated = new Date().toISOString();
  fs.writeFileSync(target, JSON.stringify(d, null, 2), 'utf8');
  if (target !== file) fs.rmSync(file);
  const st = fs.statSync(target);
  return { id: newId, title: d.title, updated: st.mtimeMs, created: st.birthtimeMs };
}

export function deleteNote(dir: string, id: string): void {
  fs.rmSync(notePath(dir, id));
}

/** 目录内关键字过滤（标题包含，大小写不敏感）——列表已全量在手，纯过滤 */
export function filterNotes(notes: NoteMeta[], q: string): NoteMeta[] {
  const s = q.trim().toLowerCase();
  if (!s) return notes;
  return notes.filter(n => n.title.toLowerCase().includes(s));
}

/** HTML 导出文件的数据块标记（往返源） */
export const NOTE_DATA_TAG = 'gitboard-note';

/** 从 HTML 文本检测 GitBoard 笔记数据块；无则返回 undefined */
export function parseNoteHtml(html: string): { doc: unknown; title?: string } | undefined {
  const m = html.match(new RegExp(`<script[^>]*type="application/json"[^>]*id="${NOTE_DATA_TAG}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) return undefined;
  try {
    const data = JSON.parse(m[1]) as { gitboardNote?: number; doc?: unknown; title?: string };
    if (data?.gitboardNote !== 1 || !data.doc) return undefined;
    return { doc: data.doc, title: data.title };
  } catch {
    return undefined;
  }
}

/** 内容指纹（导入去重/命名用，非加密） */
export function contentFingerprint(doc: unknown): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 8);
}
