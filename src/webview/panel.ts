/**
 * GraphPanel —— WebviewPanel 生命周期、消息路由、操作编排（设计方案 3/6/8 节）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import * as vscode from 'vscode';
import { createT, resolveLang, type Lang, type Translate } from '../common/i18n';
import type { Commit, LogFilter, RepoMeta, RepoState } from '../common/models';
import type { ColWidths, ConfigDto, ExtEvent, ExtResponse, WVRequest } from '../common/protocol';
import { GitError, GitExecutor } from '../git/executor';
import { discoverRepos, repoIdOf } from '../git/discovery';
import { GitService, EMPTY_TREE } from '../git/service';
import { RepoWatcher } from '../git/watcher';
import { OpRunner, type OpSpec, type PullStrategy } from '../ops/runner';
import { DiffContentProvider, GITBOARD_SCHEME, EMPTY_REF, gitboardUri } from './diffProvider';

function readConfig(): ConfigDto {
  const cfg = vscode.workspace.getConfiguration('gitboard');
  const rowHeight = cfg.get<'compact' | 'default' | 'loose'>('rowHeight', 'default');
  return {
    language: cfg.get('language', 'auto'),
    dateFormat: cfg.get('dateFormat', 'datetime'),
    rowHeightPx: rowHeight === 'compact' ? 20 : rowHeight === 'loose' ? 28 : 24,
    graphStyle: cfg.get('graphStyle', 'curved'),
    graphColumnWidth: cfg.get('graphColumnWidth', 180),
    maxTagChips: cfg.get('maxTagChips', 2),
    showRemoteChips: cfg.get('showRemoteChips', true),
    detailPanelPosition: cfg.get('detailPanelPosition', 'bottom'),
    commitPageSize: cfg.get('commitPageSize', 500),
    maxAutoLoad: cfg.get('maxAutoLoad', 20000),
    fetchOnOpen: cfg.get('fetchOnOpen', true),
    fetchPrune: cfg.get('fetchPrune', true),
    defaultPullStrategy: cfg.get('defaultPullStrategy', 'merge'),
  };
}

export function builtinGitPath(): string | undefined {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return undefined;
    const exports = (ext.isActive ? ext.exports : undefined) as any;
    const p = exports?.getAPI?.(1)?.git?.path;
    return typeof p === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

/** 空筛选默认值 */
const DEFAULT_FILTER: LogFilter = { ref: null, author: '', since: '', until: '' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeLogFilter(src: any): LogFilter {
  const ref = typeof src?.ref === 'string' && src.ref ? src.ref : null;
  const author = typeof src?.author === 'string' ? src.author.trim().slice(0, 200) : '';
  const since = typeof src?.since === 'string' && DATE_RE.test(src.since) ? src.since : '';
  const until = typeof src?.until === 'string' && DATE_RE.test(src.until) ? src.until : '';
  return { ref, author, since, until };
}

export class GraphPanel {
  private static current: GraphPanel | undefined;

  /** 每次仓库状态刷新后通知（侧栏树监听以同步分支名） */
  static readonly onDidStateChange = new vscode.EventEmitter<void>();
  static readonly onDidState = GraphPanel.onDidStateChange.event;

  readonly roots = new Map<string, string>();          // repoId → root（diffProvider 共享）
  private panel!: vscode.WebviewPanel;
  private executor?: GitExecutor;
  private service?: GitService;
  private runner?: OpRunner;
  private repos: RepoMeta[] = [];
  private currentRepoId?: string;
  private filters = new Map<string, LogFilter>();
  private lastSelectedSha?: string;
  private stateVersions = new Map<string, number>();
  private watchers = new Map<string, RepoWatcher>();
  private commitCache = new Map<string, Map<string, Commit>>();
  private lastState?: RepoState;
  private opSeq = 0;
  private autoFetchDone = false;
  private config: ConfigDto = readConfig();
  private lang: Lang = resolveLang(this.config.language, vscode.env.language);
  private t: Translate = createT(this.lang);
  private statusBarItem?: vscode.StatusBarItem;
  private disposed = false;
  private readonly channel = vscode.window.createOutputChannel('GitBoard');

  static show(context: vscode.ExtensionContext, repoId?: string): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      if (repoId) GraphPanel.current.openRepo(repoId);
      return GraphPanel.current;
    }
    const p = new GraphPanel(context);
    GraphPanel.current = p;
    if (repoId) p.pendingRepoId = repoId;
    return p;
  }

  private pendingRepoId?: string;
  private ready = false;

  /** 面板已就绪时切换仓库；未就绪时挂起待 bootstrap 完成 */
  private openRepo(repoId: string): void {
    if (!this.ready) {
      this.pendingRepoId = repoId;
      return;
    }
    if (repoId !== this.currentRepoId && this.repos.some(r => r.id === repoId)) {
      void this.selectRepo(repoId);
    }
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'gitboard.view',
      this.t('app'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 面板隐藏（切换到文件页签等）时保留 Webview 状态，切回后详情不丢
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
      },
    );
    this.panel.iconPath = undefined;
    this.panel.webview.html = this.buildHtml();

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        GITBOARD_SCHEME,
        new DiffContentProvider(() => this.service, this.roots),
      ),
      vscode.window.onDidChangeActiveColorTheme(() => this.post({ t: 'themeChanged' })),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('gitboard')) return;
        this.config = readConfig();
        this.lang = resolveLang(this.config.language, vscode.env.language);
        this.t = createT(this.lang);
        this.panel.title = this.t('app');
        this.post({ t: 'configChanged', config: this.config, language: this.lang });
        this.updateStatusBar();
      }),
    );

    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  private dispose(): void {
    this.disposed = true;
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.statusBarItem?.dispose();
    this.channel.dispose();
    GraphPanel.current = undefined;
  }

  private post(msg: ExtEvent | ExtResponse): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  // ---------- HTML ----------

  private buildHtml(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const outDir = path.join(this.context.extensionUri.fsPath, 'out');
    let js = '';
    let css = '';
    try { js = fs.readFileSync(path.join(outDir, 'webview.js'), 'utf8'); } catch { /* dev 尚未构建 */ }
    try { css = fs.readFileSync(path.join(outDir, 'webview.css'), 'utf8'); } catch { /* 无样式 */ }
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
<div id="app" class="root"></div>
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }

  // ---------- 消息路由 ----------

  private async onMessage(m: unknown): Promise<void> {
    if (m && (m as any).t === 'bootstrap') {
      await this.handleBootstrap();
      return;
    }
    const req = m as WVRequest;
    if (typeof req?.id !== 'number' || typeof req?.cmd !== 'string') return;   // E_PROTOCOL：静默丢弃
    this.channel.appendLine(`[req] ${req.cmd} #${req.id}`);
    try {
      const data = await this.route(req.cmd, req.args ?? {});
      this.post({ t: 'res', id: req.id, ok: true, data });
    } catch (e) {
      const msg = e instanceof GitError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);
      this.channel.appendLine(`[err] ${req.cmd}: ${msg}`);
      this.post({ t: 'res', id: req.id, ok: false, error: msg });
    }
  }

  private async route(cmd: string, args: any): Promise<any> {
    switch (cmd) {
      case 'selectRepo':
        await this.selectRepo(String(args.repoId));
        return null;
      case 'refresh':
        await this.refresh();
        return null;
      case 'loadMore':
        return this.loadMore(Number(args.offset));
      case 'commitDetail':
        return this.commitDetail(String(args.sha));
      case 'diff':
        return this.service!.diffOf(this.currentRoot(), args.mode, String(args.sha), String(args.path), args.base ? String(args.base) : undefined);
      case 'setFilter': {
        const cur = this.filters.get(this.currentRepoId!) ?? DEFAULT_FILTER;
        this.filters.set(this.currentRepoId!, sanitizeLogFilter({ ...cur, ref: args.ref, author: args.author ?? cur.author, since: args.since ?? cur.since, until: args.until ?? cur.until }));
        await this.refresh();
        return null;
      }
      case 'op:fetch':
        this.startOp({ kind: 'fetch', all: args.all !== false, remote: args.remote, prune: args.prune ?? this.config.fetchPrune });
        return null;
      case 'op:pull':
        this.startOp({ kind: 'pull', remote: args.remote, branch: args.branch, strategy: (args.strategy ?? this.config.defaultPullStrategy) as PullStrategy, autostash: !!args.autostash });
        return null;
      case 'op:push':
        this.startOp({ kind: 'push', remote: args.remote, branch: args.branch, setUpstream: !!args.setUpstream });
        return null;
      case 'op:reset':
        this.startOp({ kind: 'reset', sha: args.sha, mode: args.mode ?? 'mixed' });
        return null;
      case 'op:checkout':
        this.startOp({ kind: 'checkout', ref: args.ref, sha: args.sha, detached: !!args.detached, trackFrom: args.trackFrom });
        return null;
      case 'op:cancel':
        this.runner?.cancel(Number(args.opId));
        return null;

      case 'ui:openFile': {
        const rel = String(args.path);
        const file = this.safeJoin(this.currentRoot(), rel);
        if (!fs.existsSync(file)) {
          throw new Error(this.t('fileNotFound', { path: rel }));
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: false });
        return null;
      }
      case 'ui:openFileAt': {
        const u = gitboardUri(this.currentRepoId!, path.basename(String(args.path)), String(args.sha), String(args.path));
        const doc = await vscode.workspace.openTextDocument(u);
        await vscode.window.showTextDocument(doc, { preview: true });
        return null;
      }
      case 'ui:openDiffEditor':
        return this.openDiffEditor(args);
      case 'ui:revealInFM': {
        const rel = String(args.path);
        const root = this.currentRoot();
        const target = this.safeJoin(root, rel);
        this.channel.appendLine(`[reveal] target=${target} exists=${fs.existsSync(target)}`);
        if (fs.existsSync(target)) {
          await this.revealInFileManager(target);
          this.channel.appendLine('[reveal] explorer spawned, notifying');
          // 用 VS Code 原生通知，绝无遗漏
          void vscode.window.showInformationMessage(`${this.t('revealed')}: ${rel}`);
          return null;
        }
        // 文件已不在工作区（如浏览历史提交时已被删除）：回退到最近仍存在的父目录
        let dir = path.dirname(target);
        while (dir !== root && !fs.existsSync(dir)) dir = path.dirname(dir);
        if (fs.existsSync(dir)) {
          await this.revealInFileManager(dir);
          this.channel.appendLine(`[reveal] fallback dir=${dir}`);
          void vscode.window.showWarningMessage(this.t('revealParent'));
          return null;
        }
        this.channel.appendLine('[reveal] not found anywhere');
        void vscode.window.showWarningMessage(this.t('fileNotFound', { path: rel }));
        return null;
      }
      case 'ui:copy':
        await vscode.env.clipboard.writeText(String(args.text));
        return null;
      case 'ui:saveColWidths':
        await this.context.globalState.update('gitboard.colWidths', this.sanitizeColWidths(args.widths));
        return null;
      case 'ui:openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gitboard');
        return null;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }

  // ---------- 初始化与仓库 ----------

  private async handleBootstrap(): Promise<void> {
    if (!this.executor) {
      const configured = vscode.workspace.getConfiguration('gitboard').get<string>('gitPath', '') || '';
      try {
        this.executor = await GitExecutor.detect(configured, builtinGitPath());
      } catch (e) {
        this.ready = true;
        this.post({ t: 'ready', config: this.config, repos: [], language: this.lang, colWidths: this.readColWidths(), selectedSha: this.lastSelectedSha });
        this.post({ t: 'notify', level: 'error', message: `${this.t('gitNotFound')} — ${this.t('gitNotFoundHint')}` });
        return;
      }
      this.service = new GitService(this.executor);
      this.runner = new OpRunner(this.executor);
    }
    this.repos = await discoverRepos(this.executor, vscode.workspace.workspaceFolders ?? []);
    for (const r of this.repos) this.roots.set(r.id, r.root);
    const version = String((this.context.extension.packageJSON as any).version ?? '');
    this.post({ t: 'ready', config: this.config, repos: this.repos, language: this.lang, colWidths: this.readColWidths(), selectedSha: this.lastSelectedSha, version });
    this.ready = true;
    if (this.pendingRepoId && this.repos.some(r => r.id === this.pendingRepoId)) {
      const id = this.pendingRepoId;
      this.pendingRepoId = undefined;
      await this.selectRepo(id);
    } else if (this.currentRepoId) {
      // webview 被回收后重建：重发当前仓库状态
      await this.refresh();
    } else if (this.repos.length) {
      await this.selectRepo(this.repos[0].id);
    }
  }

  private currentRoot(): string {
    const root = this.currentRepoId ? this.roots.get(this.currentRepoId) : undefined;
    if (!root) throw new Error('no repository selected');
    return root;
  }

  private async selectRepo(repoId: string): Promise<void> {
    if (!this.repos.some(r => r.id === repoId)) return;
    this.currentRepoId = repoId;
    this.watchers.get(repoId)?.dispose();
    this.watchers.delete(repoId);
    const root = this.roots.get(repoId)!;
    const watcher = new RepoWatcher(root, () => { void this.refresh(); });
    watcher.start();
    this.watchers.set(repoId, watcher);

    await this.refresh();

    if (!this.autoFetchDone && this.config.fetchOnOpen && this.lastState?.remotes.length) {
      this.autoFetchDone = true;
      this.startOp({ kind: 'fetch', all: true, prune: this.config.fetchPrune });
    }
  }

  /** 重建当前仓库 RepoState 并推送（保留过滤） */
  private async refresh(): Promise<void> {
    if (!this.service || !this.currentRepoId) return;
    const repoId = this.currentRepoId;
    const root = this.roots.get(repoId)!;
    const version = (this.stateVersions.get(repoId) ?? 0) + 1;
    this.stateVersions.set(repoId, version);
    try {
      const state = await this.service.buildState(root, repoId, this.filters.get(repoId) ?? DEFAULT_FILTER, this.config.commitPageSize, version);
      this.lastState = state;
      const cache = new Map<string, Commit>();
      for (const c of state.commits) cache.set(c.sha, c);
      this.commitCache.set(repoId, cache);
      // 记忆的选中提交已不在当前列表（过滤/切换分支等）则清除
      if (this.lastSelectedSha && !cache.has(this.lastSelectedSha)) {
        this.lastSelectedSha = undefined;
      }
      this.post({ t: 'repoState', state });
      this.updateStatusBar();
      GraphPanel.onDidStateChange.fire();
    } catch (e) {
      this.post({ t: 'notify', level: 'error', message: String((e as Error)?.message ?? e) });
    }
  }

  private async loadMore(offset: number): Promise<{ commits: unknown[]; hasMore: boolean } | null> {
    if (!this.service || !this.currentRepoId) return null;
    const repoId = this.currentRepoId;
    const root = this.roots.get(repoId)!;
    const ctx = {
      localBranches: new Set(this.lastState?.branches.map(b => b.name) ?? []),
      remoteBranches: new Set(this.lastState?.remotes.flatMap(g => g.branches.map(b => b.name)) ?? []),
    };
    const filter = this.filters.get(repoId) ?? DEFAULT_FILTER;
    const { commits, hasMore } = await this.service.commitsPage(root, filter, offset, this.config.commitPageSize, ctx);
    const cache = this.commitCache.get(repoId);
    for (const c of commits) cache?.set(c.sha, c);
    this.post({ t: 'commitsAppend', repoId, offset, commits, hasMore });
    return { commits: commits.map(c => c.sha), hasMore };
  }

  private async commitDetail(sha: string): Promise<unknown> {
    if (!this.service) throw new Error('not ready');
    const repoId = this.currentRepoId!;
    this.lastSelectedSha = sha;   // 面板重建（Webview 被回收）后恢复选中
    let commit = this.commitCache.get(repoId)?.get(sha);
    if (!commit) {
      // 兜底：不在已加载页内（极少发生）——以 sha 作为 ref 单条查询
      const { commits } = await this.service.commitsPage(this.currentRoot(), { ...DEFAULT_FILTER, ref: sha }, 0, 1);
      commit = commits[0];
      if (!commit) throw new Error(`commit not found: ${sha}`);
      this.commitCache.get(repoId)?.set(sha, commit);
    }
    return this.service.detailOf(this.currentRoot(), commit);
  }

  private async openDiffEditor(args: any): Promise<null> {
    const sha = String(args.sha);
    const filePath = String(args.path);
    const base = args.base ? String(args.base) : undefined;
    const worktree = !!args.worktree;
    const commit = this.commitCache.get(this.currentRepoId!)?.get(sha);
    const leftRef = base ?? commit?.parents[0] ?? EMPTY_REF;
    const fileName = path.basename(filePath);
    const left = gitboardUri(this.currentRepoId!, fileName, leftRef, filePath);
    const right = worktree
      ? vscode.Uri.file(this.safeJoin(this.currentRoot(), filePath))
      : gitboardUri(this.currentRepoId!, fileName, sha, filePath);
    const leftShort = leftRef === EMPTY_REF || leftRef === EMPTY_TREE ? 'new' : leftRef.slice(0, 7);
    const rightShort = worktree ? 'worktree' : sha.slice(0, 7);
    await vscode.commands.executeCommand(
      'vscode.diff', left, right, `${fileName} (${leftShort} ↔ ${rightShort})`, { preview: true },
    );
    return null;
  }

  // ---------- 操作 ----------

  private startOp(spec: OpSpec): void {
    if (!this.runner || !this.currentRepoId) return;
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    const kind = spec.kind;
    const label = this.t(kind);
    void this.runner.run(
      root, spec, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind, text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t(`${kind}Done`) : this.t('opFailed', { op: label }),
    ).then(outcome => {
      if (outcome.message === 'cancelled') {
        this.post({ t: 'opResult', opId, kind, ok: false, message: this.t('opCancelled') });
        return;
      }
      this.post({
        t: 'opResult', opId, kind, ok: outcome.ok,
        message: outcome.message, outputTail: outcome.outputTail,
      });
      if (outcome.ok) void this.refresh();
    });
  }

  /** 命令面板快捷操作（作用于当前分支） */
  quickOp(kind: 'fetch' | 'pull' | 'push'): void {
    if (!this.currentRepoId) return;
    const st = this.lastState;
    const head = st?.head;
    const branchInfo = st?.branches.find(b => b.isHead);
    const upstream = branchInfo?.upstream;
    const remote = upstream?.split('/')[0] ?? 'origin';
    if (kind === 'fetch') this.startOp({ kind: 'fetch', all: true, prune: this.config.fetchPrune });
    if (kind === 'pull') {
      if (!upstream) { void vscode.window.showWarningMessage(this.t('pullNoUpstream')); return; }
      this.startOp({ kind: 'pull', remote, branch: head?.branch, strategy: this.config.defaultPullStrategy });
    }
    if (kind === 'push') {
      this.startOp({ kind: 'push', remote, branch: head?.branch ?? 'HEAD', setUpstream: !upstream });
    }
  }

  // ---------- 杂项 ----------

  private safeJoin(root: string, rel: string): string {
    // 两侧都过 path.resolve 规范化（git 根可能带正斜杠，resolve 后为系统分隔符）
    const normRoot = path.resolve(root);
    const resolved = path.resolve(root, rel);
    if (resolved !== normRoot && !resolved.startsWith(normRoot + path.sep)) {
      throw new Error(`path escapes repository root: ${rel}`);   // E_PATH_OUTSIDE
    }
    return resolved;
  }

  /**
   * 在系统文件管理器中定位文件（选中该文件）。
   * Windows 实测（窗口标题级验证）：直接 spawn explorer（含 verbatim/detached 变体）不创建窗口，
   * 唯一稳定创建窗口的形态是经 cmd 执行 `explorer /select,"路径"`（exec 默认走 cmd /c）。
   * explorer 正常情况退出码为 1，仅 ENOENT 等字符串错误码才回退 revealFileInOS。
   */
  private async revealInFileManager(target: string): Promise<void> {
    const fallback = (): void => {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target))
        .then(() => undefined, () => undefined);
    };
    try {
      if (process.platform === 'win32') {
        const q = target.replace(/"/g, '');
        exec(`explorer /select,"${q}"`, err => {
          if (err && typeof err.code === 'string') fallback();   // 启动失败（如 ENOENT）；退出码 1 为正常
        });
      } else if (process.platform === 'darwin') {
        const child = spawn('open', ['-R', target], { detached: true, stdio: 'ignore' });
        child.once('error', () => fallback());
        child.unref();
      } else {
        const child = spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' });
        child.once('error', () => fallback());
        child.unref();
      }
    } catch {
      fallback();
    }
  }

  private readColWidths(): ColWidths | undefined {
    const w = this.context.globalState.get<Partial<ColWidths>>('gitboard.colWidths');
    return w ? this.sanitizeColWidths(w) : undefined;
  }

  private sanitizeColWidths(w: any): ColWidths {
    const clamp = (v: unknown, def: number, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : def;
    return {
      graph: clamp(w?.graph, 150, 60, 400),
      msg: clamp(w?.msg, 460, 220, 2000),
      author: clamp(w?.author, 120, 70, 400),
      sha: clamp(w?.sha, 90, 60, 200),
    };
  }

  private updateStatusBar(): void {
    const enabled = vscode.workspace.getConfiguration('gitboard').get<boolean>('showStatusBarItem', true);
    if (!this.statusBarItem) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      this.statusBarItem.name = 'GitBoard';
      this.statusBarItem.command = 'gitboard.open';
    }
    const st = this.lastState;
    if (!st || st.head.branch === undefined && !st.head.detached) {
      this.statusBarItem.hide();
      return;
    }
    this.statusBarItem.text = `⑂ ${st.head.detached ? this.t('detachedHead') : st.head.branch}`;
    if (enabled) this.statusBarItem.show(); else this.statusBarItem.hide();
  }
}
