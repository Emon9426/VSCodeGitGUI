/**
 * 快速笔记面板（v0.15.0）——与 Git 主面板完全独立：
 * 零 git import、独立 webview bundle（out/notes.js + notes.css）、懒加载（extension.ts 动态 import）。
 * 职责：面板生命周期、消息路由、目录/文件 IO 编排、导出管线（md/html/pdf）、AI 编辑（复用 vscode.lm）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { createT, resolveLang, type Lang, type Translate } from '../common/i18n';
import type { ExportFmt, NoteMeta, NotesCommand, NotesEvent, NotesOpenOpts, NotesResponse } from '../common/notesProtocol';
import { lmApi, userMessage, classifyLmError } from '../ai/lm';
import {
  createNote, defaultNotesDir, deleteNote, listNotes, notePath, parseNoteHtml,
  readNote, renameNote, saveNote,
} from './notesStore';
import { docToMarkdown } from './exportMd';
import { buildExportHtml } from './exportHtml';
import { htmlToPdf } from './pdf';

export class NotesPanel {
  static current: NotesPanel | undefined;

  private panel!: vscode.WebviewPanel;
  private lang: Lang;
  private t: Translate;
  private dir: string;
  private disposed = false;
  private aiCts?: vscode.CancellationTokenSource;
  /** 待分发的打开定位（命令直达 / HTML 导入），bootstrap 完成后消费 */
  private opts?: NotesOpenOpts;

  /** 打开面板（单例）；extension.ts 懒加载调用 */
  static async open(context: vscode.ExtensionContext, opts?: NotesOpenOpts): Promise<void> {
    if (NotesPanel.current) {
      NotesPanel.current.panel.reveal();
      if (opts) NotesPanel.current.consumeOpts(opts);
      return;
    }
    const p = new NotesPanel(context);
    NotesPanel.current = p;
    if (opts) p.opts = opts;
    await p.bootstrap();
  }

  /** 从导出的 HTML 打开为可编辑笔记（往返）：无数据块返回 false */
  static async openHtml(context: vscode.ExtensionContext, htmlPath: string): Promise<boolean> {
    let html: string;
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch { return false; }
    const data = parseNoteHtml(html);
    if (!data) return false;
    await NotesPanel.open(context, { importHtml: { title: data.title || 'note', doc: data.doc } });
    return true;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    const cfg = vscode.workspace.getConfiguration('gitboard');
    this.lang = resolveLang(cfg.get<'auto' | 'zh-CN' | 'en'>('language', 'auto'), vscode.env.language);
    this.t = createT(this.lang);
    this.dir = context.globalState.get<string>('gitboard.notesDir') || defaultNotesDir();
  }

  /** 面板 HTML：与主面板同款 CSP（加密随机 nonce），内联 out/notes.js 与 out/notes.css */
  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const outDir = path.join(this.context.extensionUri.fsPath, 'out');
    let js = '';
    let css = '';
    try { js = fs.readFileSync(path.join(outDir, 'notes.js'), 'utf8'); } catch { /* dev 尚未构建 */ }
    try { css = fs.readFileSync(path.join(outDir, 'notes.css'), 'utf8'); } catch { /* 无样式 */ }
    js = js.replace(/<\/script/gi, '<\\/script');
    const csp = this.panel.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="${this.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; font-src ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${css}</style>
</head>
<body>
<div id="notes-app"></div>
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  private async bootstrap(): Promise<void> {
    this.panel = vscode.window.createWebviewPanel(
      'gitboard.notes',
      this.t('notesApp'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')] },
    );
    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(m => void this.onMessage(m));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('gitboard.language')) return;
      const cfg = vscode.workspace.getConfiguration('gitboard');
      this.lang = resolveLang(cfg.get<'auto' | 'zh-CN' | 'en'>('language', 'auto'), vscode.env.language);
      this.t = createT(this.lang);
      this.panel.title = this.t('notesApp');
    }));
    const version = String((this.context.extension.packageJSON as any).version ?? '');
    const fonts = this.readFonts();
    this.post({ t: 'notesReady', dir: this.dir, notes: this.safeList(), language: this.lang, version, fontZh: fonts.zh, fontEn: fonts.en });
    const o = this.opts;
    this.opts = undefined;
    if (o?.loadId) this.post({ t: 'openNote', id: o.loadId });
    if (o?.importHtml) this.post({ t: 'importNote', title: o.importHtml.title, doc: o.importHtml.doc });
  }

  /** 面板已存在时的再次定位（命令直达 / 从 HTML 打开） */
  private consumeOpts(opts: NotesOpenOpts): void {
    if (opts.loadId) this.post({ t: 'openNote', id: opts.loadId });
    if (opts.importHtml) this.post({ t: 'importNote', title: opts.importHtml.title, doc: opts.importHtml.doc });
  }

  private safeList(): NoteMeta[] {
    try { return listNotes(this.dir); } catch { return []; }
  }

  /** 默认字体（中/英分设；globalState 记忆） */
  private readFonts(): { zh: string; en: string } {
    return {
      zh: this.context.globalState.get<string>('gitboard.notesFontZh') || '微软雅黑',
      en: this.context.globalState.get<string>('gitboard.notesFontEn') || 'Segoe UI',
    };
  }

  private pushList(): void {
    this.post({ t: 'notesList', notes: this.safeList() });
  }

  private dispose(): void {
    this.disposed = true;
    this.aiCts?.cancel();
    this.aiCts?.dispose();
    NotesPanel.current = undefined;
  }

  private post(msg: NotesEvent | NotesResponse): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: unknown): Promise<void> {
    const req = m as { id?: number; cmd?: string; args?: any };
    if (typeof req?.id !== 'number' || typeof req?.cmd !== 'string') return;   // 畸形消息静默丢弃
    try {
      const data = await this.route(req.cmd as NotesCommand, req.args ?? {});
      this.post({ t: 'res', id: req.id, ok: true, data });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.post({ t: 'res', id: req.id, ok: false, error: msg });
    }
  }

  private async route(cmd: NotesCommand, args: any): Promise<unknown> {
    switch (cmd) {
      case 'notes.list':
        return this.safeList();
      case 'notes.read':
        return readNote(this.dir, String(args.id));
      case 'notes.create': {
        const meta = createNote(this.dir, String(args.title ?? '') || this.t('notesUntitledDefault'));
        this.pushList();
        return meta;
      }
      case 'notes.rename': {
        const meta = renameNote(this.dir, String(args.id), String(args.title));
        this.pushList();
        return meta;
      }
      case 'notes.delete':
        deleteNote(this.dir, String(args.id));
        this.pushList();
        return null;
      case 'notes.save': {
        const at = saveNote(this.dir, String(args.id), args.doc, String(args.title ?? ''), args.bg);
        this.pushList();
        return { savedAt: at };
      }
      case 'notes.pickDir': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          defaultUri: vscode.Uri.file(this.dir), title: this.t('notesPickDirTitle'),
          openLabel: this.t('notesChangeDir'),
        });
        if (!picked?.length) return null;
        this.setNotesDir(picked[0].fsPath);
        return { dir: this.dir };
      }
      case 'notes.setDir': {
        this.setNotesDir(String(args.dir));
        return { dir: this.dir };
      }
      case 'notes.export':
        return this.exportNote(args, false);
      case 'notes.saveAs':
        return this.exportNote(args, true);
      case 'notes.revealInFM':
        // notePath 内含 slug 恒等白名单 + resolve 边界 + dirname 三重校验，杜绝路径穿越
        this.revealFile(notePath(this.dir, String(args.id)));
        return null;
      case 'notes.pickImage': {
        // v0.17 反馈 #7：系统对话框选图 → data URL 内嵌正文（对话框来源路径，无穿越面）
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectMany: false,
          title: this.t('notesPickImageTitle'),
          filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] },
        });
        if (!picked?.length) return null;
        const file = picked[0].fsPath;
        const st = fs.statSync(file);
        if (st.size > 8 * 1024 * 1024) throw new Error(this.t('notesImageTooLarge'));
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        const buf = fs.readFileSync(file);
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(file) };
      }
      case 'notes.setDefFont': {
        const script = args.script === 'zh' ? 'notesFontZh' : 'notesFontEn';
        const family = String(args.family ?? '').slice(0, 80);
        await this.context.globalState.update(script, family);
        return this.readFonts();
      }
      case 'notes.ai': {
        const text = await this.aiGenerate(String(args.action), String(args.text ?? ''), typeof args.custom === 'string' ? args.custom : '');
        return { text };
      }
      case 'notes.aiCancel':
        this.aiCts?.cancel();
        return null;
      default:
        throw new Error(`unknown notes command: ${cmd}`);
    }
  }

  private setNotesDir(dir: string): void {
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    this.dir = resolved;
    void this.context.globalState.update('gitboard.notesDir', resolved);
    this.post({ t: 'dirChanged', dir: resolved });
    this.pushList();
  }

  // ---------- 导出（md / html / pdf / 另存为） ----------

  private async saveFileDialog(defaultName: string, label: string, ext: string): Promise<vscode.Uri | undefined> {
    return vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.dir, defaultName + ext)),
      filters: { [label]: [ext.replace('.', '')] },
      title: this.t('notesExportTitle'),
    });
  }

  private async exportNote(args: any, saveAs: boolean): Promise<unknown> {
    void saveAs;   // 导出与另存为走同一保存对话框（另存为语义 = 选择新位置落副本）
    const title = String(args.title ?? 'note');
    const fmt = String(args.fmt) as ExportFmt;
    const doc = args.doc;
    const safeName = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'note';
    if (fmt === 'md') {
      const md = docToMarkdown(doc);
      const target = await this.saveFileDialog(safeName, 'Markdown', '.md');
      if (!target) return null;
      fs.writeFileSync(target.fsPath, md, 'utf8');
      this.post({ t: 'notify', level: 'info', message: this.t('notesExportDone', { path: target.fsPath }) });
      return { path: target.fsPath };
    }
    if (fmt === 'html') {
      const html = buildExportHtml(title, doc, String(args.htmlBody ?? ''), new Date().toISOString(), args.bg);
      const target = await this.saveFileDialog(safeName, 'HTML', '.html');
      if (!target) return null;
      fs.writeFileSync(target.fsPath, html, 'utf8');
      this.post({ t: 'notify', level: 'info', message: this.t('notesExportDone', { path: target.fsPath }) });
      return { path: target.fsPath };
    }
    // PDF：html → 临时文件 → headless 静默转换；失败回退 = html 落盘 + 系统浏览器打开手动打印
    const html = buildExportHtml(title, doc, String(args.htmlBody ?? ''), new Date().toISOString(), args.bg);
    const target = await this.saveFileDialog(safeName, 'PDF', '.pdf');
    if (!target) return null;
    const tmpHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-notes-')), 'note.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');
    const r = await htmlToPdf(tmpHtml, target.fsPath);
    try { fs.rmSync(path.dirname(tmpHtml), { recursive: true, force: true }); } catch { /* ignore */ }
    if (r.ok) {
      this.post({ t: 'notify', level: 'info', message: this.t('notesPdfDone', { path: r.pdfPath }) });
      return { path: r.pdfPath };
    }
    const fallbackHtml = target.fsPath.replace(/\.pdf$/i, '.html');
    fs.writeFileSync(fallbackHtml, html, 'utf8');
    void vscode.env.openExternal(vscode.Uri.file(fallbackHtml));
    this.post({ t: 'notify', level: 'warn', message: this.t('notesPdfFallback') });
    return { fallback: true, path: fallbackHtml };
  }

  /** 资源管理器定位（win 用 explorer /select 字面量形态；mac/linux 系统打开器；程序名全部字面量） */
  private revealFile(p: string): void {
    try {
      if (!fs.existsSync(p)) return;
      if (process.platform === 'win32') spawn('explorer', ['/select,', p], { windowsHide: true, detached: true }).unref();
      else if (process.platform === 'darwin') spawn('open', ['-R', p], { detached: true }).unref();
      else spawn('xdg-open', [path.dirname(p)], { detached: true }).unref();
    } catch { /* 静默 */ }
  }

  // ---------- AI 编辑（复用 vscode.lm Copilot 通路，与提交信息 AI 同开关） ----------

  private async aiGenerate(action: string, text: string, custom: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('gitboard');
    if (!cfg.get<boolean>('ai.enabled', true)) throw new Error(this.t('notesAiNoModel'));
    const lm = lmApi(vscode);
    const models = lm ? await lm.selectChatModels() : [];
    const model = models.find(m => m.isDefault) ?? models[0];
    if (!model) throw new Error(this.t('notesAiNoModel'));
    const instruction = this.aiInstruction(action, custom);
    const messages = [
      userMessage(vscode, `You are a note editing assistant. ${instruction}\n\nOutput ONLY the resulting text without explanations.\n\n---\n${text}`),
    ];
    this.aiCts?.dispose();
    this.aiCts = new vscode.CancellationTokenSource();
    const token = this.aiCts.token;
    const res = await model.sendRequest(messages, {}, token);
    let out = '';
    try {
      for await (const chunk of res.text) {
        if (token.isCancellationRequested) break;
        out += chunk;
        this.post({ t: 'aiChunk', text: chunk });
      }
    } catch (e) {
      if (classifyLmError(e) !== 'canceled') throw new Error('aiFailed');
    }
    if (token.isCancellationRequested) throw new Error('canceled');
    this.post({ t: 'aiDone', text: out });
    return out;
  }

  private aiInstruction(action: string, custom: string): string {
    switch (action) {
      case 'continue': return 'Continue writing the given text naturally, keeping its language and style. Return the original text unchanged followed by the continuation.';
      case 'polish': return 'Polish the text for clarity and flow, keeping its original language and meaning.';
      case 'translate': return 'Translate the text to English.';
      case 'summary': return 'Summarize the text into concise bullet points, keeping the original language.';
      case 'todo': return 'Convert the text into a checklist ("- [ ] ...") of actionable items, keeping the original language.';
      default: return custom ? `Follow the user instruction: ${custom}` : 'Improve the text.';
    }
  }
}
