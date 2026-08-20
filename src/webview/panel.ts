/**
 * GraphPanel —— WebviewPanel 生命周期、消息路由、操作编排（设计方案 3/6/8 节）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import * as vscode from 'vscode';
import { createT, resolveLang, type Lang, type Translate } from '../common/i18n';
import type { Commit, FileEntry, LogFilter, RepoMeta, RepoState, WorkState } from '../common/models';
import type { ColWidths, ConfigDto, ExtEvent, ExtResponse, WVRequest } from '../common/protocol';
import { GitError, GitExecutor, isGitError } from '../git/executor';
import { discoverRepos, repoIdOf } from '../git/discovery';
import { GitService, EMPTY_TREE } from '../git/service';
import { RepoWatcher } from '../git/watcher';
import { OpRunner, type OpSpec, type PullStrategy } from '../ops/runner';
import { DiffContentProvider, GITBOARD_SCHEME, EMPTY_REF, gitboardUri } from './diffProvider';
import { lmApi, userMessage, classifyLmError } from '../ai/lm';
import { buildSystemPrompt, buildUserPrompt, type CommitPromptCtx } from '../ai/prompt';

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
    logOrder: cfg.get('logOrder', 'topo'),
    aiEnabled: cfg.get('ai.enabled', true),
    aiLanguage: cfg.get('ai.language', 'auto'),
    aiLearnFromHistory: cfg.get('ai.learnFromHistory', true),
    aiUseWorkspaceInstructions: cfg.get('ai.useWorkspaceInstructions', true),
    commitClearMessage: cfg.get('commit.clearMessage', true),
    commitPushAfter: cfg.get('commit.pushAfter', false),
    startView: cfg.get('startView', 'graph'),
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
  /** 各仓库已加载提交深度（同 filter 才复用）：refresh 时补页到此深度，列表不因刷新截断回首页 */
  private loadedCounts = new Map<string, { count: number; filterKey: string }>();
  private lastState?: RepoState;
  private opSeq = 0;
  private autoFetchDone = false;
  private config: ConfigDto = readConfig();
  private lang: Lang = resolveLang(this.config.language, vscode.env.language);
  private t: Translate = createT(this.lang);
  private statusBarItem?: vscode.StatusBarItem;
  private disposed = false;
  private readonly channel = vscode.window.createOutputChannel('GitBoard');
  // 工作副本（Commit 功能）
  private lastWorkJson = '';
  private lastWorkEntries?: { staged: FileEntry[]; unstaged: FileEntry[]; conflicts: FileEntry[] };
  private aiCts?: vscode.CancellationTokenSource;
  private pendingWorkView = false;

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
    this.aiCts?.cancel();
    this.aiCts?.dispose();
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
        await this.refresh(true);   // 用户显式刷新：必推送（绕过指纹去重）
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
        await this.refresh(true);   // 用户显式切换筛选：必推送
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

      // ---------- 工作副本（Commit 功能） ----------
      case 'work.state':
        return this.workStateNow();
      case 'work.stage':
        this.workStagePaths(Array.isArray(args.paths) ? args.paths.map(String) : [], true);
        return null;
      case 'work.unstage':
        this.workStagePaths(Array.isArray(args.paths) ? args.paths.map(String) : [], false);
        return null;
      case 'work.resolveConflict':
        this.workResolveConflict(Array.isArray(args.paths) ? args.paths.map(String) : [], args.ours !== false);
        return null;
      // ---------- 标签 ----------
      case 'tag.create':
        this.startOp({ kind: 'tagCreate', name: String(args.name ?? ''), sha: args.sha ? String(args.sha) : undefined, message: args.message ? String(args.message) : undefined });
        return null;
      case 'tag.delete':
        this.startOp({ kind: args.remote ? 'tagDeleteRemote' : 'tagDelete', name: String(args.name ?? ''), remote: args.remote ? String(args.remote) : undefined });
        return null;
      case 'tag.push':
        this.startOp({ kind: 'tagPush', name: String(args.name ?? ''), remote: args.remote ? String(args.remote) : undefined });
        return null;
      case 'work.stageAll':
        this.startWorkOp({ kind: 'stage', all: true });
        return null;
      case 'work.unstageAll':
        this.startWorkOp({ kind: 'unstage', paths: ['.'] });
        return null;
      case 'work.discard':
        this.workDiscard(Array.isArray(args.paths) ? args.paths.map(String) : []);
        return null;
      case 'work.deleteFile':
        return this.deleteFiles(Array.isArray(args.paths) ? args.paths.map(String) : []);
      case 'work.diff': {
        const rel = String(args.path);
        const untracked = (this.lastWorkEntries?.unstaged ?? []).some(e => e.path === rel && e.untracked);
        if (untracked) return this.service!.untrackedDiffOf(this.safeJoin(this.currentRoot(), rel));
        return this.service!.diffOf(this.currentRoot(), 'worktree', 'HEAD', rel);
      }
      case 'work.commit':
        return this.workCommit(args);
      case 'work.recentMessages': {
        const list = await this.service!.recentMessages(this.currentRoot(), 12);
        const seen = new Set<string>();
        const out: { subject: string; body: string }[] = [];
        for (const m of list) {
          if (seen.has(m.subject)) continue;
          seen.add(m.subject);
          out.push(m);
          if (out.length >= 8) break;
        }
        return out;
      }
      case 'work.amendLoad': {
        const head = await this.service!.headCommitOf(this.currentRoot());
        if (!head) throw new Error(this.t('noCommits'));
        return { shortSha: head.shortSha, message: head.subject + (head.body ? `\n\n${head.body}` : '') };
      }
      case 'work.aiModels':
        return this.aiModels();
      case 'work.aiGenerate':
        return this.aiGenerate(args.modelId ? String(args.modelId) : undefined);
      case 'work.aiCancel':
        this.aiCts?.cancel();
        return null;
      case 'work.saveDraft':
        await this.context.globalState.update(`gitboard.commitDraft:${this.currentRepoId}`, {
          message: String(args.draft?.message ?? '').slice(0, 60000),
          pushAfter: !!args.draft?.pushAfter,
          amend: !!args.draft?.amend,
        });
        return null;
      case 'work.loadDraft':
        return this.context.globalState.get(`gitboard.commitDraft:${this.currentRepoId}`) ?? null;
      case 'work.saveLayout': {
        const clamp = (v: unknown, def: number, min: number, max: number) =>
          typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : def;
        await this.context.globalState.update('gitboard.workLayout', {
          filesW: clamp(args.filesW, 272, 200, 420),
          barH: clamp(args.barH, 150, 104, 320),
        });
        return null;
      }
      case 'ui:setView':
        await this.context.globalState.update('gitboard.lastView', args.view === 'work' ? 'work' : 'graph');
        return null;
      case 'ui:pickLanguage':
        await this.pickLanguage();
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
      // webview 被回收后重建：重发当前仓库状态（强制——新 webview 无本地状态，指纹相同也必须推）
      await this.refresh(true);
    } else if (this.repos.length) {
      await this.selectRepo(this.repos[0].id);
    }
    // 初始视图：命令直达 / startView 配置（work | last）
    let showWork = this.pendingWorkView;
    this.pendingWorkView = false;
    if (this.config.startView === 'work') showWork = true;
    else if (this.config.startView === 'last' && this.context.globalState.get<string>('gitboard.lastView') === 'work') showWork = true;
    if (showWork) this.post({ t: 'showWork' });
  }

  private currentRoot(): string {
    const root = this.currentRepoId ? this.roots.get(this.currentRepoId) : undefined;
    if (!root) throw new Error('no repository selected');
    return root;
  }

  private async selectRepo(repoId: string): Promise<void> {
    if (!this.repos.some(r => r.id === repoId)) return;
    this.currentRepoId = repoId;
    this.lastPostedFingerprint = undefined;   // 换仓库：指纹失效，必推送
    this.watchers.get(repoId)?.dispose();
    this.watchers.delete(repoId);
    const root = this.roots.get(repoId)!;
    const watcher = new RepoWatcher(root, files => { this.onWatch(files); });
    watcher.start();
    this.watchers.set(repoId, watcher);

    await this.refresh();

    if (!this.autoFetchDone && this.config.fetchOnOpen && this.lastState?.remotes.length) {
      this.autoFetchDone = true;
      this.startOp({ kind: 'fetch', all: true, prune: this.config.fetchPrune });
    }
  }

  /**
   * watcher 事件分类（v0.7.2 性能优化）：
   * 仅 index 变化（暂存/取消暂存类操作）→ 只推工作副本状态，跳过整图重建；
   * 其余（HEAD/refs 等）→ 全量刷新。轻量路径仍校验 HEAD 未变，防 fs.watch 偶发丢事件。
   */
  private onWatch(files: string[]): void {
    if (!this.service || !this.currentRepoId) return;
    const indexOnly = files.length > 0 && files.every(f => f === 'index');
    if (!indexOnly) {
      void this.refresh();
      return;
    }
    void (async () => {
      try {
        const root = this.roots.get(this.currentRepoId!)!;
        const head = await this.service!.headShaOf(root);
        if ((head ?? '') !== (this.lastState?.head.sha ?? '')) {
          await this.refresh();   // HEAD 实际变了（漏事件兜底）
          return;
        }
        await this.workStateNow();
      } catch { /* 下次触发兜底 */ }
    })();
  }

  /**
   * 重建当前仓库 RepoState 并推送（保留过滤）。
   * 合并去抖（v0.7.2）：进行中的调用被复用，期间的新请求合并为结束后再跑一轮；
   * 指纹去重：refs/HEAD/dirty/筛选均未变化时跳过推送，webview 免于全量重渲染。
   */
  private refreshInFlight?: Promise<void>;
  private refreshAgain = false;
  private lastPostedFingerprint?: string;

  /**
   * force：跳过指纹去重，本轮必推送 repoState。
   * 用于用户显式操作（刷新按钮 / pull / fetch / push / checkout / reset / commit 成功）——
   * webview 本地可能处于脏状态（分页错位残留等），只有重推 repoState 才能重建；
   * watcher 自动刷新不传 force，保留去重以抑制刷新风暴。
   */
  private refresh(force = false): Promise<void> {
    if (force) this.lastPostedFingerprint = undefined;
    if (this.refreshInFlight) {
      this.refreshAgain = true;   // 已有进行中/排队的刷新：合并进来（指纹已清，本轮或尾随轮必推）
      return this.refreshInFlight;
    }
    const p = (async () => {
      for (;;) {
        this.refreshAgain = false;
        await this.doRefresh();
        if (!this.refreshAgain) return;
      }
    })();
    this.refreshInFlight = p.finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    if (!this.service || !this.currentRepoId) return;
    const repoId = this.currentRepoId;
    const root = this.roots.get(repoId)!;
    const version = (this.stateVersions.get(repoId) ?? 0) + 1;
    this.stateVersions.set(repoId, version);
    try {
      // 一次 status 同时喂 buildState（分支信息）与工作副本矩阵（v0.7.2 少跑一次）
      const status = await this.service.statusFullOf(root);
      const filter = this.filters.get(repoId) ?? DEFAULT_FILTER;
      const state = await this.service.buildState(root, repoId, filter, this.config.commitPageSize, version, {
        statusInfo: status.info,
        order: this.config.logOrder,
      });
      // 已加载深度补齐：用户加载过多页时，按当前 refs 快照补页到原深度再推送——
      // 避免列表被刷新截断回首页（滚动位置 clamp + 新旧快照混拼都会造成"提交缺失"）
      const fk = JSON.stringify(filter);
      const loaded = this.loadedCounts.get(repoId);
      const target = loaded && loaded.filterKey === fk ? loaded.count : 0;
      const needMore = target > state.commits.length && state.hasMore;
      if (needMore) {
        const ctx = {
          localBranches: new Set(state.branches.map(b => b.name)),
          remoteBranches: new Set(state.remotes.flatMap(g => g.branches.map(b => b.name))),
        };
        let fp0 = '';
        try { fp0 = this.refsFingerprintOf(await this.service.refsOf(root)); } catch { /* 校验尽力而为 */ }
        const extra: Commit[] = [];
        let more = state.hasMore;
        while (state.commits.length + extra.length < target && more) {
          const page = await this.service.commitsPage(root, filter, state.commits.length + extra.length, this.config.commitPageSize, ctx, this.config.logOrder);
          if (!page.commits.length) { more = false; break; }
          extra.push(...page.commits);
          more = page.hasMore;
        }
        try {
          // 补页期间 refs 未漂移才合并（各页同快照，拼接无缺口）；漂移则按首页推送，下轮刷新重推完整深度
          if (!fp0 || this.refsFingerprintOf(await this.service.refsOf(root)) === fp0) {
            state.commits.push(...extra);
            state.hasMore = more;
            state.commitsLoaded = state.commits.length;
          }
        } catch { /* 校验尽力而为 */ }
      }
      this.loadedCounts.set(repoId, { count: state.commits.length, filterKey: fk });
      this.lastState = state;
      const cache = new Map<string, Commit>();
      for (const c of state.commits) cache.set(c.sha, c);
      this.commitCache.set(repoId, cache);
      // 记忆的选中提交已不在当前列表（过滤/切换分支等）则清除
      if (this.lastSelectedSha && !cache.has(this.lastSelectedSha)) {
        this.lastSelectedSha = undefined;
      }
      // 指纹去重：refs/HEAD/dirty/筛选/分页状态未变则不重复推送
      const fp = JSON.stringify([
        state.head.sha, state.head.branch, state.head.detached,
        state.status.dirtyCount, state.filterRef, state.logFilter, state.hasMore,
        state.branches.map(b => b.fullName + b.sha).join(';'),
        state.remotes.flatMap(g => g.branches.map(b => b.name + b.sha)).join(';'),
        state.tags.map(t => t.name + t.sha).join(';'),
      ]);
      if (fp !== this.lastPostedFingerprint) {
        this.lastPostedFingerprint = fp;
        this.post({ t: 'repoState', state });
        this.updateStatusBar();
        GraphPanel.onDidStateChange.fire();
      }
      void this.doWorkState({ entries: status.entries, merging: status.merging }).catch(() => undefined);
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
    let fp0 = '';
    try { fp0 = this.refsFingerprintOf(await this.service.refsOf(root)); } catch { /* 校验尽力而为 */ }
    const { commits, hasMore } = await this.service.commitsPage(root, filter, offset, this.config.commitPageSize, ctx, this.config.logOrder);
    // 在途期间 refs 已变：此页与首页不同快照，拼接会错位（缺提交/重复）——不推送，
    // 主动驱动一轮强制刷新（watcher 可能丢事件，repoState 到达可复位前端加载状态并重建列表）
    try {
      if (fp0 && this.refsFingerprintOf(await this.service.refsOf(root)) !== fp0) {
        void this.refresh(true);
        return null;
      }
    } catch { /* 校验尽力而为 */ }
    this.loadedCounts.set(repoId, { count: offset + commits.length, filterKey: JSON.stringify(filter) });
    const cache = this.commitCache.get(repoId);
    for (const c of commits) cache?.set(c.sha, c);
    this.post({ t: 'commitsAppend', repoId, offset, commits, hasMore });
    return { commits: commits.map(c => c.sha), hasMore };
  }

  /** refs 快照指纹：全部 ref 的 sha 串联（loadMore 在途漂移检测用，实时读取而非 lastState 缓存） */
  private refsFingerprintOf(refs: { sha: string }[]): string {
    return refs.map(r => r.sha).join('|');
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

  /** lastState 引用快照（fullName → sha），fetch 前后对比用 */
  private snapshotRefs(): Map<string, string> {
    const m = new Map<string, string>();
    const st = this.lastState;
    if (!st) return m;
    for (const b of st.branches) m.set(b.fullName, b.sha);
    for (const g of st.remotes) for (const b of g.branches) m.set(b.fullName, b.sha);
    for (const tg of st.tags) m.set(tg.name, tg.sha);
    return m;
  }

  private startOp(spec: OpSpec): void {
    if (!this.runner || !this.currentRepoId) return;
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    const kind = spec.kind;
    const label = this.t(kind);
    // 立即播报"进行中"（不等首条 --progress 输出），按钮随即进入繁忙态
    this.post({ t: 'opProgress', opId, kind, text: '' });
    const refsBefore = kind === 'fetch' ? this.snapshotRefs() : undefined;
    void this.runner.run(
      root, spec, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind, text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t(`${kind}Done`) : this.t('opFailed', { op: label }),
    ).then(async outcome => {
      if (outcome.message === 'cancelled') {
        this.post({ t: 'opResult', opId, kind, ok: false, message: this.t('opCancelled') });
        return;
      }
      // 结果细化：让"点了但没变化"也有明确反馈（v0.7.1）
      let message = outcome.message;
      if (outcome.ok) {
        if (kind === 'fetch' && refsBefore) {
          try {
            const after = await this.service!.refsOf(root);
            let n = 0;
            for (const r of after) {
              if (refsBefore.get(r.fullName) !== r.sha) n++;
            }
            message = n > 0 ? this.t('fetchUpdated', { n }) : this.t('fetchUpToDate');
          } catch { /* 保留默认消息 */ }
        } else if (kind === 'pull' && /already up to date/i.test(outcome.stdoutTail ?? '')) {
          message = this.t('pullUpToDate');
        } else if (kind === 'push') {
          message = `${this.t('pushDone')}：${spec.branch ?? 'HEAD'} → ${spec.remote ?? 'origin'}`;
        }
      }
      this.post({
        t: 'opResult', opId, kind, ok: outcome.ok,
        message, outputTail: outcome.outputTail,
      });
      if (outcome.ok) {
        void this.refresh(true);   // 操作成功：强制重推（fetch/pull/push/checkout/reset 后表格必刷新）
        void this.workStateNow().catch(() => undefined);
      }
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

  // ---------- 工作副本（Commit 功能，设计方案 v1.3） ----------

  /** 命令面板「提交更改」：打开主界面并切到工作副本视图 */
  openWorkView(): void {
    if (this.ready) this.post({ t: 'showWork' });
    else this.pendingWorkView = true;
  }

  /** 界面语言三选一（跟随 VS Code / 简体中文 / English）；写回配置触发全 UI 即时切换 */
  async pickLanguage(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitboard');
    const cur = cfg.get<'auto' | 'zh-CN' | 'en'>('language', 'auto');
    const mk = (label: string, value: 'auto' | 'zh-CN' | 'en') => ({
      label, value, description: value === cur ? '✓' : undefined,
    });
    const pick = await vscode.window.showQuickPick(
      [mk(this.t('langAuto'), 'auto'), mk(this.t('langZh'), 'zh-CN'), mk(this.t('langEn'), 'en')],
      { placeHolder: this.t('langSwitchTitle') },
    );
    if (pick && pick.value !== cur) {
      await cfg.update('language', pick.value, vscode.ConfigurationTarget.Global);
      // 配置变化 → onDidChangeConfiguration → configChanged → Webview 全量换语言（无需重载）
    }
  }

  /**
   * 计算当前 WorkState；变化才推送（轻量 statusTick，不重建提交图）。
   * 合并去抖（v0.7.2）：进行中的调用被复用，期间的新请求合并为结束后再跑一轮
   * ——操作回调与 watcher 的重复计算归一。
   */
  private workInFlight?: Promise<WorkState>;
  private workAgain = false;

  private workStateNow(): Promise<WorkState> {
    if (this.workInFlight) {
      this.workAgain = true;
      return this.workInFlight;
    }
    const p = (async () => {
      for (;;) {
        this.workAgain = false;
        const st = await this.doWorkState();
        if (!this.workAgain) return st;
      }
    })();
    this.workInFlight = p.finally(() => { this.workInFlight = undefined; }) as Promise<WorkState>;
    return this.workInFlight;
  }

  private async doWorkState(pre?: { entries: FileEntry[]; merging: boolean }): Promise<WorkState> {
    if (!this.service || !this.currentRepoId) throw new Error('not ready');
    const repoId = this.currentRepoId;
    const root = this.roots.get(repoId)!;
    const [wc, head] = await Promise.all([
      this.service.workingCopyOf(root, pre),
      this.service.headCommitOf(root),
    ]);
    const state: WorkState = {
      repoId,
      staged: wc.staged,
      unstaged: wc.unstaged,
      conflicts: wc.conflicts,
      dirtyCount: wc.dirtyCount,
      merging: wc.merging,
      mergeKind: wc.mergeKind,
      headShortSha: head?.shortSha ?? '',
      headSubject: head?.subject ?? '',
      headDate: head?.date ?? '',
    };
    this.lastWorkEntries = wc;
    const json = JSON.stringify(state);
    if (json !== this.lastWorkJson) {
      this.lastWorkJson = json;
      this.post({ t: 'workState', state });
    }
    return state;
  }

  /** stage / unstage / discard 类：成功只推 workState（不整图刷新，watcher 兜底）；成功不弹 toast */
  private startWorkOp(spec: OpSpec): void {
    if (!this.runner || !this.currentRepoId) return;
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    const kind = spec.kind;
    const quiet = spec.kind === 'stage' || spec.kind === 'unstage';
    if (!quiet) this.post({ t: 'opProgress', opId, kind, text: '' });
    void this.runner.run(root, spec, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind, text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t(`${kind}Done`) : this.t('opFailed', { op: this.t(kind) }),
    ).then(outcome => {
      if (quiet && outcome.ok) {
        this.post({ t: 'opResult', opId, kind, ok: true });   // 无 message：前端进度条收起且不弹 toast
      } else if (outcome.message === 'cancelled') {
        this.post({ t: 'opResult', opId, kind, ok: false, message: this.t('opCancelled') });
      } else {
        this.post({ t: 'opResult', opId, kind, ok: outcome.ok, message: outcome.message, outputTail: outcome.outputTail });
      }
      if (outcome.ok) void this.workStateNow();
    });
  }

  private workStagePaths(paths: string[], stage: boolean): void {
    if (!paths.length) return;
    this.startWorkOp({ kind: stage ? 'stage' : 'unstage', paths });
  }

  /**
   * 冲突二选一：checkout --ours/--theirs + add；全部解决且处于普通合并中 → 自动完成合并提交
   * （完成提交走 startOp：有「合并完成」toast + 强制整图刷新 + 工作副本刷新）。
   */
  private workResolveConflict(paths: string[], ours: boolean): void {
    if (!paths.length || !this.runner || !this.currentRepoId) return;
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    void this.runner.run(root, { kind: 'resolveConflict', paths, ours }, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind: 'resolveConflict', text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t('resolveConflictDone') : this.t('opFailed', { op: this.t('resolveConflict') }),
    ).then(async outcome => {
      // 成功静默（列表即时刷新即反馈），失败弹 toast
      this.post({ t: 'opResult', opId, kind: 'resolveConflict', ok: outcome.ok, message: outcome.ok ? undefined : outcome.message });
      const st = await this.workStateNow().catch(() => undefined);
      if (st && !st.conflicts.length && st.merging) {
        try {
          if (fs.statSync(path.join(root, '.git', 'MERGE_HEAD')).isFile()) {
            this.startOp({ kind: 'commitNoEdit' });   // 自动完成合并提交
          }
        } catch { /* 非 merge（rebase 等）：不自动提交，由用户继续操作 */ }
      }
    });
  }

  /** 丢弃：已跟踪 restore 回 HEAD（含已暂存），未跟踪 clean -fd */
  private workDiscard(paths: string[]): void {
    if (!paths.length) return;
    const untracked = new Set((this.lastWorkEntries?.unstaged ?? []).filter(e => e.untracked).map(e => e.path));
    const tracked = paths.filter(p => !untracked.has(p));
    const clean = paths.filter(p => untracked.has(p));
    if (tracked.length) this.startWorkOp({ kind: 'discard', paths: tracked });
    if (clean.length) this.startWorkOp({ kind: 'discardClean', paths: clean });
  }

  /**
   * 删除文件：从磁盘移除（非 git rm——不动暂存区）。
   * 未跟踪文件删除后直接消失；已跟踪文件转「未暂存」D 状态，暂存后才计入提交。
   * 顺带关闭这些文件的编辑器标签，避免悬空脏编辑器。
   */
  private async deleteFiles(paths: string[]): Promise<{ ok: true; deleted: number }> {
    const root = this.currentRoot();
    let deleted = 0;
    const failures: string[] = [];
    for (const rel of paths.slice(0, 500)) {
      try {
        const abs = this.safeJoin(root, rel);
        if (abs === path.resolve(root)) continue;   // 防御：不接受仓库根本身
        fs.rmSync(abs, { recursive: true, force: true });
        for (const tg of vscode.window.tabGroups.all) {
          for (const tab of tg.tabs) {
            const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
            if (uri && path.resolve(uri.fsPath) === abs) void vscode.window.tabGroups.close(tab);
          }
        }
        deleted++;
      } catch (e) {
        failures.push(rel);
        this.channel.appendLine(`[delete] ${rel}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
    if (failures.length) throw new Error(this.t('deleteFileFailed', { n: failures.length }) + failures.slice(0, 5).join('、'));
    if (deleted) {
      void this.workStateNow();
      void this.refresh(true);   // 脏计数变化影响侧栏徽标与提交图
    }
    return { ok: true, deleted };
  }

  /** 提交（可 all=/amend=/push= 链式推送）；成功后清草稿并整图刷新 */
  private async workCommit(args: any): Promise<{ ok: true; shortSha?: string }> {
    const message = String(args.message ?? '');
    if (!message.split('\n')[0].trim()) throw new Error(this.t('needMessage'));
    const amend = !!args.amend;
    const all = !!args.all;
    const push = !!args.push;
    if (this.lastWorkEntries?.conflicts.length) {
      throw new Error(this.t('conflictBlock'));   // 未解决冲突阻塞提交：引导先选保留版本
    }
    if (!amend && !all && !(this.lastWorkEntries?.staged.length)) throw new Error(this.t('needStage'));

    if (all) this.startWorkOp({ kind: 'stage', all: true });
    // 临时文件经 os.tmpdir（Windows 下 /tmp 对 Node 不可见）；提交完即删
    const file = path.join(os.tmpdir(), `gitboard-commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(file, message, 'utf8');

    const root = this.currentRoot();
    const opId = ++this.opSeq;
    this.post({ t: 'opProgress', opId, kind: 'commit', text: '' });
    let outcome;
    try {
      outcome = await this.runner!.run(root, { kind: 'commit', messageFile: file, amend }, opId,
        (text, pct) => this.post({ t: 'opProgress', opId, kind: 'commit', text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
        ok => ok ? this.t(amend ? 'amendDone' : 'commitDone') : this.t('opFailed', { op: this.t('commit') }),
      );
    } finally {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
    this.post({ t: 'opResult', opId, kind: 'commit', ok: outcome.ok, message: outcome.message, outputTail: outcome.outputTail });
    if (!outcome.ok) throw new Error(outcome.message ?? 'commit failed');

    await this.context.globalState.update(`gitboard.commitDraft:${this.currentRepoId}`, undefined);
    void this.refresh(true);   // 提交成功：强制重推
    void this.workStateNow();
    if (push) this.quickOp('push');
    const head = await this.service!.headCommitOf(root);
    return { ok: true, shortSha: head?.shortSha };
  }

  /** 可用 Copilot 模型列表（未安装/未登录返回空数组 → 前端隐藏 AI 入口） */
  private async aiModels(): Promise<{ id: string; name: string; family: string; isDefault: boolean }[]> {
    const lm = lmApi(vscode);
    if (!lm || !this.config.aiEnabled) return [];
    try {
      const models = await lm.selectChatModels({ vendor: 'copilot' });
      return models.map(m => ({ id: m.id, name: m.name, family: m.family, isDefault: !!m.isDefault }));
    } catch {
      return [];
    }
  }

  /** AI 生成提交信息：上下文（暂存 diff + 指示文件 + 风格）→ sendRequest 流式转发 aiChunk */
  private async aiGenerate(modelId?: string): Promise<null> {
    const fail = (code: 'noModel' | 'auth' | 'quota' | 'canceled' | 'error', message?: string): null => {
      this.post({ t: 'aiError', code, message });
      return null;
    };
    if (!this.config.aiEnabled) return fail('error', this.t('aiDisabled'));
    const lm = lmApi(vscode);
    if (!lm) return fail('noModel');

    // 首次使用隐私确认（暂存差异与工程指示文件将发送至 GitHub Copilot 服务）
    if (this.context.globalState.get<boolean>('gitboard.aiConsent') !== true) {
      const allow = await vscode.window.showInformationMessage(
        this.t('aiPrivacyText'), { modal: true }, this.t('aiPrivacyAllow'),
      );
      if (allow !== this.t('aiPrivacyAllow')) return fail('error', this.t('aiDeclined'));
      await this.context.globalState.update('gitboard.aiConsent', true);
    }

    let models;
    try {
      models = await lm.selectChatModels({ vendor: 'copilot' });
    } catch (e) {
      return fail(classifyLmError(e), String((e as Error)?.message ?? e).slice(0, 200));
    }
    if (!models.length) return fail('noModel');
    const family = vscode.workspace.getConfiguration('gitboard').get<string>('ai.modelFamily', '');
    const model = (modelId ? models.find(m => m.id === modelId) : undefined)
      ?? (family ? models.find(m => m.family === family) : undefined)
      ?? models.find(m => m.isDefault) ?? models[0];

    this.aiCts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.aiCts = cts;
    // 看门狗：60s 无输出（含首字节）自动取消——LM 请求无内建超时，
    // 大 prompt 挂起时若无兜底，前端 aiBusy 永久卡死
    let watchdog: NodeJS.Timeout | undefined;
    let timedOut = false;
    const armWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => { timedOut = true; cts.cancel(); }, 60_000);
    };
    try {
      const root = this.currentRoot();
      const useInstructions = this.config.aiUseWorkspaceInstructions;
      const ctx = await this.service!.buildCommitContext(root, { learnFromHistory: this.config.aiLearnFromHistory, useInstructions });
      const pctx: CommitPromptCtx & { useInstructions?: boolean } = {
        ...ctx,
        instructions: useInstructions ? ctx.instructions : [],
        language: this.config.aiLanguage,
      };
      const prompt = `${buildSystemPrompt(pctx)}\n\n${buildUserPrompt(pctx)}`;
      this.channel.appendLine(`[ai] model=${model.name} instructions=${pctx.instructions.length} diffChars=${ctx.stagedDiff.length} summaryChars=${ctx.stagedSummary.length}`);
      armWatchdog();
      const res = await model.sendRequest([userMessage(vscode, prompt)], {}, cts.token);
      for await (const chunk of res.text) {
        armWatchdog();
        this.post({ t: 'aiChunk', text: chunk });
      }
      this.post({ t: 'aiDone', model: model.name, instructions: pctx.instructions.length });
    } catch (e) {
      // 上下文构建（git diff 超时等）与 LM 调用统一兜底：必须发 aiError，否则前端永久 busy
      if (timedOut) {
        fail('error', this.t('aiTimeout'));
      } else if (isGitError(e)) {
        this.channel.appendLine(`[ai] context build failed: ${e.message}`);
        fail('error', this.t('aiContextFailed'));
      } else {
        const code = classifyLmError(e);
        fail(code, code === 'error' ? String((e as Error)?.message ?? e).slice(0, 200) : undefined);
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      cts.dispose();
      if (this.aiCts === cts) this.aiCts = undefined;
    }
    return null;
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
