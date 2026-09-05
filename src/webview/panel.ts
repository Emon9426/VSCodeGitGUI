/**
 * GraphPanel —— WebviewPanel 生命周期、消息路由、操作编排（设计方案 3/6/8 节）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { createT, resolveLang, type Lang, type Translate } from '../common/i18n';
import type { Commit, FileEntry, LogFilter, MergeSessionAny, ProjectInfo, PullFileStat, RepoMeta, RepoState, WorkState } from '../common/models';
import { MERGE_MAX_BYTES, MERGE_MAX_LINES, RENAME_SEP } from '../common/models';
import type { ColWidths, ConfigDto, ExtEvent, ExtResponse, WVRequest } from '../common/protocol';
import { GitError, GitExecutor, isGitError } from '../git/executor';
import { discoverRepos, repoIdOf, sharedDetect } from '../git/discovery';
import { GitService, EMPTY_TREE, SCAN_CAP, authorDateWindow, cleanAuthorName } from '../git/service';
import { FilesService, safeRelPath } from '../git/files';
import { PullSummaryService } from '../git/summary';
import { RepoWatcher } from '../git/watcher';
import { detectMove, semanticToOurs } from '../git/parse';
import { OpRunner, type OpSpec, type PullStrategy } from '../ops/runner';
import { OpVerifier, type VerifyResult } from '../ops/verify';
import { DiffContentProvider, GITBOARD_SCHEME, EMPTY_REF, gitboardUri } from './diffProvider';
import { fsExistsRobust, revealableAncestor, revealSpawnForm, type RevealSelectStyle } from './revealPath';
import { lmApi, userMessage, classifyLmError } from '../ai/lm';
import { buildSystemPrompt, buildUserPrompt, type CommitPromptCtx } from '../ai/prompt';
import { buildFileTree, diffContentUsable, formatEntryList } from '../ai/tree';

function readConfig(): ConfigDto {
  const cfg = vscode.workspace.getConfiguration('gitboard');
  const rowHeight = cfg.get<'compact' | 'default' | 'loose'>('rowHeight', 'default');
  return {
    language: cfg.get('language', 'auto'),
    dateFormat: cfg.get('dateFormat', 'datetime'),
    rowHeightPx: rowHeight === 'compact' ? 20 : rowHeight === 'loose' ? 28 : 24,
    graphStyle: cfg.get('graphStyle', 'github'),
    graphColumnWidth: cfg.get('graphColumnWidth', 180),
    maxTagChips: cfg.get('maxTagChips', 2),
    showRemoteChips: cfg.get('showRemoteChips', true),
    detailPanelPosition: cfg.get('detailPanelPosition', 'bottom'),
    commitPageSize: cfg.get('commitPageSize', 500),
    maxAutoLoad: cfg.get('maxAutoLoad', 20000),
    fetchOnOpen: cfg.get('fetchOnOpen', true),
    autoFetchInterval: cfg.get('autoFetchInterval', 10),
    fetchPrune: cfg.get('fetchPrune', true),
    netStallTimeout: cfg.get('netStallTimeout', 180),
    opVerify: cfg.get('opVerify', 'quick'),
    defaultPullStrategy: cfg.get('defaultPullStrategy', 'merge'),
    logOrder: cfg.get('logOrder', 'topo'),
    aiEnabled: cfg.get('ai.enabled', true),
    aiLanguage: cfg.get('ai.language', 'auto'),
    aiLearnFromHistory: cfg.get('ai.learnFromHistory', true),
    aiUseWorkspaceInstructions: cfg.get('ai.useWorkspaceInstructions', true),
    commitClearMessage: cfg.get('commit.clearMessage', true),
    commitPushAfter: cfg.get('commit.pushAfter', false),
    startView: cfg.get('startView', 'graph'),
    pullFetchSummary: cfg.get('pullFetchSummary', true),
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
const DEFAULT_FILTER: LogFilter = { ref: null, authors: [], since: '', until: '', noMerges: false };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeLogFilter(src: any): LogFilter {
  const ref = typeof src?.ref === 'string' && src.ref ? src.ref : null;
  const raw: unknown[] = Array.isArray(src?.authors) ? src.authors : [];
  const authors = [...new Set(
    raw
      .map(a => cleanAuthorName(String(a)))
      .filter((a): a is string => !!a),
  )].slice(0, 50);
  const since = typeof src?.since === 'string' && DATE_RE.test(src.since) ? src.since : '';
  const until = typeof src?.until === 'string' && DATE_RE.test(src.until) ? src.until : '';
  const noMerges = !!src?.noMerges;
  return { ref, authors, since, until, noMerges };
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
  private pullSummary?: PullSummaryService;
  /** 操作后快速校验（Issue #6 后续）：退出码 0 后按意图核对仓库状态 */
  private verifier?: OpVerifier;
  private files?: FilesService;
  /** explorer 右键「查看文件历史」待定位路径（webview 未就绪时排队） */
  private pendingFilesReveal: string[] = [];
  /** SourceTree 式后台自动获取定时器（面板存活期间；设置变更时重臂） */
  private fetchTimer?: NodeJS.Timeout;
  private repos: RepoMeta[] = [];
  private currentRepoId?: string;
  private filters = new Map<string, LogFilter>();
  private lastSelectedSha?: string;
  private stateVersions = new Map<string, number>();
  private watchers = new Map<string, RepoWatcher>();
  private commitCache = new Map<string, Map<string, Commit>>();
  /** 各仓库已加载提交深度（同 filter 才复用）：refresh 时补页到此深度，列表不因刷新截断回首页 */
  private loadedCounts = new Map<string, { count: number; filterKey: string }>();
  /** 各仓库扫描游标（同 filter 才复用）：带日期窗口时 git --skip 偏移 ≠ 过滤产出计数（Issue #5） */
  private scanCursors = new Map<string, { filterKey: string; scanned: number }>();
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
  /** handleBootstrap 已开始（webview 在线，可随时推送事件；pendingWorkView 等排队仅在此之前有效） */
  private bootstrapped = false;
  /** 仓库扫描已完成至少一次（webview 重建走热路径，ready 直接带全量 repos） */
  private reposResolved = false;
  /** 进行中的仓库扫描（in-flight 去重；完成后清空，失败不缓存以便重试） */
  private reposResolve?: Promise<void>;

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
        this.armAutoFetch();   // 间隔调整 / 开关：重建定时器
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
    if (this.fetchTimer) clearInterval(this.fetchTimer);
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
    // CSP nonce 用加密随机（而非 Math.random）
    const nonce = crypto.randomBytes(16).toString('hex');
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
    // 仓库扫描未完成的早期请求（外壳先行渲染期间用户已可点击）：等扫描结束再路由，
    // 避免 service/runner 尚未就绪时报错；ensureRepos 幂等且不抛（失败路径同样置 resolved）
    if (!this.reposResolved) await this.ensureRepos();
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
      case 'refresh': {
        // 纳入统一进度模型：进度行可见（refresh 秒级完成，不支持取消）
        const opId = ++this.opSeq;
        this.post({ t: 'opProgress', opId, kind: 'refresh', text: '' });
        try {
          await this.refresh(true);   // 用户显式刷新：必推送（绕过指纹去重）
          this.post({ t: 'opResult', opId, kind: 'refresh', ok: true });
        } catch (e) {
          this.post({ t: 'opResult', opId, kind: 'refresh', ok: false, message: String((e as Error)?.message ?? e) });
        }
        return null;
      }
      case 'loadMore':
        return this.loadMore(Number(args.offset));
      case 'commitDetail':
        return this.commitDetail(String(args.sha));
      case 'diff':
        return this.service!.diffOf(this.currentRoot(), args.mode, String(args.sha), String(args.path), args.base ? String(args.base) : undefined);
      case 'setFilter': {
        const cur = this.filters.get(this.currentRepoId!) ?? DEFAULT_FILTER;
        // authors 显式传空数组表示清空（不能用 ?? 回退 cur）；noMerges 同理由纯视图切换驱动
        this.filters.set(this.currentRepoId!, sanitizeLogFilter({
          ...cur,
          ref: args.ref === undefined ? cur.ref : args.ref,
          authors: args.authors === undefined ? cur.authors : args.authors,
          since: args.since ?? cur.since,
          until: args.until ?? cur.until,
          noMerges: args.noMerges === undefined ? cur.noMerges : !!args.noMerges,
        }));
        await this.refresh(true);   // 用户显式切换筛选：必推送
        return null;
      }
      case 'listAuthors':
        return this.service!.authorsOf(this.currentRoot());
      case 'op:fetch':
        this.startOp({ kind: 'fetch', all: args.all !== false, remote: args.remote, prune: args.prune ?? this.config.fetchPrune });
        return null;
      case 'op:pull':
        // F1（Issue #6）：不传 remote/branch——git 按分支级配置 branch.<name>.remote/merge 拉取
        this.startOp({ kind: 'pull', strategy: (args.strategy ?? this.config.defaultPullStrategy) as PullStrategy, autostash: !!args.autostash });
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
      case 'ui:openFiles': {
        // 详情面板多选批量打开：不存在的（历史提交中已删除/移动）跳过并回报
        const rels = Array.isArray(args.paths) ? args.paths.map(String).slice(0, 50) : [];
        const missing: string[] = [];
        let opened = 0;
        for (const rel of rels) {
          const file = this.safeJoin(this.currentRoot(), rel);
          if (!fs.existsSync(file)) { missing.push(rel); continue; }
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: false });
          opened++;
        }
        return { opened, missing };
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
        // 存在性探测用 robust 形态：严格 MAX_PATH 系统上 >259 的真实文件普通 stat 会误报不存在
        this.channel.appendLine(`[reveal] target=${target} exists=${fsExistsRobust(target)}`);
        if (fsExistsRobust(target)) {
          await this.revealInFileManager(target);
          this.channel.appendLine('[reveal] explorer spawned, notifying');
          // 用 VS Code 原生通知，绝无遗漏
          void vscode.window.showInformationMessage(`${this.t('revealed')}: ${rel}`);
          return null;
        }
        // 文件已不在工作区（如浏览历史提交时已被删除）：回退到最近仍存在的父目录
        let dir = path.dirname(target);
        while (dir !== root && !fsExistsRobust(dir)) dir = path.dirname(dir);
        if (fsExistsRobust(dir)) {
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
      case 'ui:saveDetailPct': {
        // 高度百分比持久化：不同尺寸屏幕按相对高度恢复
        if (typeof args.pct === 'number' && Number.isFinite(args.pct)) {
          await this.context.globalState.update('gitboard.detailPct', Math.max(8, Math.min(85, Math.round(args.pct * 10) / 10)));
        }
        return null;
      }
      // ---------- 文件历史页（v0.14） ----------
      case 'files.ls': {
        if (!this.files) return { items: [], kind: 'dir' as const };
        return this.files.lsOf(this.currentRoot(), String(args.dir ?? ''));
      }
      case 'files.log': {
        if (!this.files) throw new Error('not ready');
        return this.files.fileLogOf(this.currentRoot(), String(args.path ?? ''));
      }
      case 'files.dirLog': {
        if (!this.files) throw new Error('not ready');
        return this.files.dirLogOf(this.currentRoot(), String(args.dir ?? ''), args.follow !== false);
      }
      case 'files.commitDiff': {
        // 详情展开：该文件此提交的变化（path = 当时路径；diffOf 复用 commit 模式）
        if (!this.service) throw new Error('not ready');
        const sha = String(args.sha ?? '');
        if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new Error('bad sha');
        return this.service.diffOf(this.currentRoot(), 'commit', sha, String(args.path ?? ''));
      }
      case 'files.versionDiff': {
        if (!this.files) throw new Error('not ready');
        return this.files.blobDiffOf(this.currentRoot(), args.a, args.b);
      }
      case 'folder.move': {
        // 目标目录由 webview 内置目录选择对话框给出（原生 showOpenDialog 在部分环境下静默取消，已弃用）
        const rawSrcs = Array.isArray(args.srcs) ? args.srcs : [];
        const srcs = rawSrcs.map((x: any) => String(x)).filter((s: string) => !!s && safeRelPath(s) === s.trim().replace(/\\/g, '/'));
        if (rawSrcs.length && !srcs.length) {
          this.channel.appendLine('[folder.move] rejected paths: ' + rawSrcs.join(', '));
          return { ok: false, reason: 'invalid', error: 'unsupported path' };
        }
        if (!srcs.length) return { ok: false, reason: 'invalid', error: 'no selection' };
        if (typeof args.dst !== 'string') return { ok: false, reason: 'invalid', error: 'missing dst' };   // 目标必须显式给出（防旧客户端缺省误移到根）
        const dstRaw = args.dst.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        if (dstRaw !== '' && !safeRelPath(dstRaw)) return { ok: false, reason: 'invalid', error: 'unsupported target' };
        const root = this.currentRoot();
        const dstAbs = dstRaw ? path.resolve(root, dstRaw) : root;
        if (!(dstAbs === root || dstAbs.startsWith(root + path.sep))) return { ok: false, reason: 'invalid', error: 'destination out of repo' };
        const st = await fs.promises.stat(dstAbs).catch(() => null);
        if (!st || !st.isDirectory()) return { ok: false, reason: 'invalid', error: 'target not a directory' };
        for (const s of srcs) {
          if (dstRaw === s || dstRaw.startsWith(s + '/')) return { ok: false, reason: 'invalid', error: 'nested move' };
        }
        const outcome = await this.runFileOp({ kind: 'moveFolder', srcs, dst: dstRaw || '.' });
        return { ok: outcome.ok, dst: outcome.ok ? dstRaw : undefined, reason: outcome.ok ? undefined : 'failed', error: outcome.ok ? undefined : outcome.outputTail };
      }
      case 'folder.rename': {
        const p = safeRelPath(String(args.path ?? ''));
        const name = safeRelPath(String(args.newName ?? ''));
        if (!p || !name || name.includes('/')) throw new Error('bad args');
        const outcome = await this.runFileOp({ kind: 'renamePath', path: p, name });
        return { ok: outcome.ok, error: outcome.ok ? undefined : outcome.outputTail };
      }
      case 'folder.delete': {
        const paths = (Array.isArray(args.paths) ? args.paths : []).map((x: any) => String(x)).filter((s: string) => !!s && safeRelPath(s) === s.trim().replace(/\\/g, '/'));
        if (!paths.length) return { ok: false };
        const root = this.currentRoot();
        const tracked: string[] = [];
        for (const p of paths) {
          const isTracked = await this.isTracked(p);
          if (isTracked) tracked.push(p);
          else {
            const abs = path.resolve(root, p);
            if (abs === root || abs.startsWith(root + path.sep)) {
              await fs.promises.rm(abs, { recursive: true, force: true }).catch(() => undefined);
            }
          }
        }
        let ok = true;
        let error: string | undefined;
        if (tracked.length) {
          const outcome = await this.runFileOp({ kind: 'deletePaths', paths: tracked });
          ok = outcome.ok;
          error = outcome.outputTail;
        }
        if (ok) this.files?.invalidateTree(root);
        return { ok, error };
      }
      case 'ui:saveFilesLayout': {
        const w = Math.max(280, Math.min(640, Math.round(Number(args.paneW)) || 388));
        const cols = Array.isArray(args.cols)
          ? args.cols.map((n: any) => Math.max(40, Math.min(600, Math.round(Number(n)) || 80))).slice(0, 4)
          : undefined;
        await this.context.globalState.update('gitboard.filesLayout', { paneW: w, cols });
        return null;
      }
      case 'ui:saveSideCollapsed': {
        await this.context.globalState.update('gitboard.sideCollapsed', !!args.collapsed);
        return null;
      }
      case 'ui:openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gitboard');
        return null;

      // ---------- 工程切换（v0.11） ----------
      case 'projects.add': {
        const raw = String(args.path ?? '').trim();
        if (!raw) throw new Error('empty project path');
        const dir = path.resolve(raw);
        if (!fs.existsSync(dir)) throw new Error(this.t('projectNotFound', { path: dir }));
        const name = String(args.name ?? '').trim().slice(0, 80) || path.basename(dir) || dir;
        const list = this.readProjects();
        const exist = list.find(p => this.samePath(p.path, dir));
        if (exist) exist.name = name;   // 同路径重复添加 = 重命名
        else list.push({ id: repoIdOf(dir), name, path: dir });
        await this.saveProjects(list);
        return null;
      }
      case 'projects.rename': {
        const list = this.readProjects();
        const p = list.find(x => x.id === String(args.id ?? ''));
        const name = String(args.name ?? '').trim().slice(0, 80);
        if (p && name) {
          p.name = name;
          await this.saveProjects(list);
        }
        return null;
      }
      case 'projects.remove':
        await this.saveProjects(this.readProjects().filter(p => p.id !== String(args.id ?? '')));
        return null;
      case 'projects.pickFolder': {
        const picks = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
        return picks && picks[0] ? { path: picks[0].fsPath } : null;
      }
      case 'projects.open': {
        const p = this.readProjects().find(x => x.id === String(args.id ?? ''));
        if (!p) throw new Error(this.t('projectNotFound', { path: String(args.id ?? '') }));
        if (!fs.existsSync(p.path)) throw new Error(this.t('projectNotFound', { path: p.path }));
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.path), { forceNewWindow: !!args.newWindow });
        return null;
      }

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
      // ---------- 合并解决器（v0.10，设计方案 v1.3） ----------
      case 'merge.session':
        return this.mergeSessionOf(String(args.path ?? ''));
      case 'merge.resolve':
        this.mergeResolveSide(String(args.path ?? ''), args.side === 'theirs');
        return null;
      case 'merge.save':
        return this.mergeSaveFile(String(args.path ?? ''), String(args.content ?? ''));
      case 'merge.deleteAccept':
        this.mergeDeleteAccept(String(args.path ?? ''), args.side === 'theirs');
        return null;
      case 'merge.finish':
        return this.mergeFinish();
      case 'merge.abort':
        return this.mergeAbort();
      case 'merge.previewBinary':
        return this.mergePreviewBinary(String(args.path ?? ''), args.side === 'theirs');
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
          filesW: clamp(args.filesW, 272, 200, 900),
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

  /**
   * 启动时序（v0.14.7）：ready 不再等待 git 探测——外壳（配置/工程列表/布局记忆/语言）
   * 先行渲染，仓库发现后台异步进行，完成后推 reposChanged 补发；无仓库/大仓库慢加载
   * 不再阻塞整个界面。webview 回收重建（repos 已在内存）走热路径，ready 携带全量。
   */
  private async handleBootstrap(): Promise<void> {
    this.bootstrapped = true;
    const version = String((this.context.extension.packageJSON as any).version ?? '');
    this.postStartView();
    if (this.reposResolved) {
      this.post({ t: 'ready', config: this.config, repos: this.repos, language: this.lang, colWidths: this.readColWidths(), selectedSha: this.lastSelectedSha, version, ...this.readyExtras() });
      await this.afterReposReady();
      this.flushFilesReveal();   // explorer 右键在 bootstrap 期间排队的定位
      return;
    }
    this.post({ t: 'ready', config: this.config, repos: [], reposPending: true, language: this.lang, colWidths: this.readColWidths(), selectedSha: this.lastSelectedSha, version, ...this.readyExtras() });
    void this.ensureRepos();   // 后台：detect → discoverRepos → reposChanged → 自动选仓
  }

  /** 初始视图：命令直达 / startView 配置（work | last）——不依赖 git，随首个 ready 先行 */
  private postStartView(): void {
    let showWork = this.pendingWorkView;
    this.pendingWorkView = false;
    if (this.config.startView === 'work') showWork = true;
    else if (this.config.startView === 'last' && this.context.globalState.get<string>('gitboard.lastView') === 'work') showWork = true;
    if (showWork) this.post({ t: 'showWork' });
  }

  /** 仓库就绪（或确认无仓库）后接续：挂起的仓库直达 / 重建重发 / 自动选首个仓库 */
  private async afterReposReady(): Promise<void> {
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
  }

  /** 确保仓库扫描完成（幂等：进行中复用同一 promise；失败不缓存，可重试） */
  private ensureRepos(): Promise<void> {
    if (this.reposResolved) return Promise.resolve();
    if (this.reposResolve) return this.reposResolve;
    this.reposResolve = this.resolveRepos().finally(() => { this.reposResolve = undefined; });
    return this.reposResolve;
  }

  private async resolveRepos(): Promise<void> {
    if (!this.executor) {
      const configured = vscode.workspace.getConfiguration('gitboard').get<string>('gitPath', '') || '';
      try {
        this.executor = await sharedDetect(configured, builtinGitPath());
      } catch {
        // git 不可用：仍结束扫描（界面显示无仓库引导 + 错误提示），不阻塞外壳
        this.post({ t: 'reposChanged', repos: [] });
        this.reposResolved = true;
        this.ready = true;
        this.post({ t: 'notify', level: 'error', message: `${this.t('gitNotFound')} — ${this.t('gitNotFoundHint')}` });
        return;
      }
      this.service = new GitService(this.executor);
      this.runner = new OpRunner(this.executor, undefined, () => this.config.netStallTimeout);
      this.verifier = new OpVerifier(this.executor);
      this.pullSummary = new PullSummaryService(this.executor);
      this.files = new FilesService(this.executor);
      this.armAutoFetch();
    }
    this.repos = await discoverRepos(this.executor, vscode.workspace.workspaceFolders ?? []);
    for (const r of this.repos) this.roots.set(r.id, r.root);
    this.post({ t: 'reposChanged', repos: this.repos });
    this.reposResolved = true;
    this.ready = true;
    await this.afterReposReady();
    this.flushFilesReveal();   // explorer 右键排队的定位：仓库就绪后才可寻址
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
    const watcher = new RepoWatcher(
      root,
      files => { this.onWatch(files); },
      message => { this.channel.appendLine(message); },
    );
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
    this.channel.appendLine(`[watch] repo=${this.currentRepoId} files=${JSON.stringify(files)} → ${indexOnly ? '轻量' : '全量'}`);
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
    this.files?.invalidateTree(root);   // HEAD 可能已变：文件页快照失效重建
    const t0 = Date.now();
    const version = (this.stateVersions.get(repoId) ?? 0) + 1;
    this.stateVersions.set(repoId, version);
    try {
      // 一次 status 同时喂 buildState（分支信息）与工作副本矩阵（v0.7.2 少跑一次）
      const status = await this.service.statusFullOf(root);
      const filter = this.filters.get(repoId) ?? DEFAULT_FILTER;
      const { state, scanned: scanned0 } = await this.service.buildState(root, repoId, filter, this.config.commitPageSize, version, {
        statusInfo: status.info,
        order: this.config.logOrder,
      });
      const fk = JSON.stringify(filter);
      // 扫描游标（Issue #5）：带日期窗口时补页/续扫须从扫描深度（≠产出计数）继续
      this.scanCursors.set(repoId, { filterKey: fk, scanned: scanned0 });
      // 已加载深度补齐：用户加载过多页时，按当前 refs 快照补页到原深度再推送——
      // 避免列表被刷新截断回首页（滚动位置 clamp + 新旧快照混拼都会造成"提交缺失"）
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
        let scanned = scanned0;
        while (state.commits.length + extra.length < target && more) {
          const page = await this.commitsFill(root, filter, scanned, this.config.commitPageSize, ctx, this.config.logOrder);
          scanned = page.scanned;
          this.scanCursors.set(repoId, { filterKey: fk, scanned });
          if (!page.commits.length) { more = page.hasMore; break; }   // 空产出：如实保留扫描状态（cap 截断时 true，区别于扫尽）
          extra.push(...page.commits);
          more = page.hasMore;
        }
        try {
          // 补页期间 refs 未漂移才合并（各页同快照，拼接无缺口）；漂移则按首页推送，下轮刷新重推完整深度
          if (!fp0 || this.refsFingerprintOf(await this.service.refsOf(root)) === fp0) {
            state.commits.push(...extra);
            state.hasMore = more;
            state.commitsLoaded = state.commits.length;
          } else {
            // 漂移丢弃 extra：游标回拨到首页扫描深度，防深游标+浅列表造成后续续扫缺口
            this.scanCursors.set(repoId, { filterKey: fk, scanned: scanned0 });
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
      const changed = fp !== this.lastPostedFingerprint;
      if (changed) {
        this.lastPostedFingerprint = fp;
        this.post({ t: 'repoState', state });
        this.updateStatusBar();
        GraphPanel.onDidStateChange.fire();
      }
      this.channel.appendLine(`[refresh] repo=${repoId} head=${state.head.sha.slice(0, 7)} commits=${state.commits.length} pushed=${changed ? 'yes' : 'no(dedup)'} ${Math.round(Date.now() - t0)}ms`);
      void this.doWorkState({ entries: status.entries, merging: status.merging }).catch(() => undefined);
    } catch (e) {
      this.channel.appendLine(`[refresh] repo=${repoId} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
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
    const fk = JSON.stringify(filter);
    // 扫描游标（Issue #5）：带日期窗口时续扫偏移 ≠ 产出计数；无游标（同 filter 首查）回退产出计数——
    // 无窗口时两者恒等，语义不变
    const cursor = this.scanCursors.get(repoId);
    const scanOffset = cursor && cursor.filterKey === fk ? cursor.scanned : offset;
    // 状态快照令牌（Issue #5）：fill 在途期间发生过 doRefresh（stateVersions 自增，如筛选变更/刷新）
    // 则本页与游标属旧快照——不可覆写 scanCursors/loadedCounts（旧 filterKey 覆写新值会造成续扫
    // 重复/缺口），丢弃本页并强制重推，由刷新机制重建
    const ver0 = this.stateVersions.get(repoId) ?? 0;
    let fp0 = '';
    try { fp0 = this.refsFingerprintOf(await this.service.refsOf(root)); } catch { /* 校验尽力而为 */ }
    const { commits, hasMore, scanned } = await this.commitsFill(root, filter, scanOffset, this.config.commitPageSize, ctx, this.config.logOrder);
    if ((this.stateVersions.get(repoId) ?? 0) !== ver0) {
      void this.refresh(true);
      return null;
    }
    this.scanCursors.set(repoId, { filterKey: fk, scanned });
    // 在途期间 refs 已变：此页与首页不同快照，拼接会错位（缺提交/重复）——不推送，
    // 主动驱动一轮强制刷新（watcher 可能丢事件，repoState 到达可复位前端加载状态并重建列表）
    try {
      if (fp0 && this.refsFingerprintOf(await this.service.refsOf(root)) !== fp0) {
        void this.refresh(true);
        return null;
      }
    } catch { /* 校验尽力而为 */ }
    this.loadedCounts.set(repoId, { count: offset + commits.length, filterKey: fk });
    const cache = this.commitCache.get(repoId);
    for (const c of commits) cache?.set(c.sha, c);
    this.post({ t: 'commitsAppend', repoId, offset, commits, hasMore });
    return { commits: commits.map(c => c.sha), hasMore };
  }

  /**
   * 凑页补扫（Issue #5）：时间段过滤在宿主侧按作者日期进行后，单次 commitsPage 的产出
   * 可能不足 limit（窗口内提交稀疏），循环续扫直到凑满 / 扫尽 / 达 SCAN_CAP（上限截断时
   * 如实返回 hasMore，前端下次 loadMore 从 scanCursors 续扫）。
   * 无日期窗口时单发即精确（git 侧过滤与 -n/--skip 同管道），直接走 commitsPage。
   */
  private async commitsFill(root: string, filter: LogFilter, scanOffset: number, limit: number, ctx: { localBranches: Set<string>; remoteBranches: Set<string> }, order: 'topo' | 'date'): Promise<{ commits: Commit[]; hasMore: boolean; scanned: number }> {
    if (!authorDateWindow(filter.since, filter.until)) {
      return this.service!.commitsPage(root, filter, scanOffset, limit, ctx, order);
    }
    const collected: Commit[] = [];
    let scan = scanOffset;
    let hasMore = true;
    while (true) {
      const page = await this.service!.commitsPage(root, filter, scan, limit, ctx, order);
      scan = page.scanned;
      collected.push(...page.commits);
      hasMore = page.hasMore;
      if (!hasMore) break;                                   // 历史扫尽
      if (collected.length >= limit) break;                  // 凑满一页产出
      if (scan - scanOffset >= SCAN_CAP) break;              // 补扫上限
    }
    return { commits: collected, hasMore, scanned: scan };
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

  /**
   * Pull/Fetch 摘要（v0.13）：对比前后 refs 圈出拉到的新提交（排除 merge），推 webview 弹窗。
   * fetch：变化的远端跟踪 ref 新 sha 为起点；pull：新 HEAD 为起点——可达于新起点、
   * 不可达于任何旧引用即为"拉到的提交"。尽力而为：失败不影响操作结果。
   */
  private async collectPullSummary(
    root: string,
    kind: 'fetch' | 'pull',
    before: Map<string, string>,
    headBefore?: string,
  ): Promise<void> {
    if (!this.service || !this.pullSummary || !this.config.pullFetchSummary || !this.currentRepoId) return;
    const after = await this.service.refsOf(root);
    const include: string[] = [];
    if (kind === 'fetch') {
      for (const r of after) {
        if (r.prefix !== 'refs/remotes/') continue;
        if (before.get(r.fullName) !== r.sha) include.push(r.sha);   // 新分支（旧值缺失）与前进均计
      }
    } else {
      const head = await this.service.headShaOf(root);
      if (head && head !== headBefore) include.push(head);
    }
    if (!include.length) return;
    // pull 的排除集只取本地侧（本地分支 + 旧 HEAD）：远端跟踪引用天然包含"新到本地"的上游提交
    // （fetch/后台自动获取先行更新 refs 时尤甚），全量排除会使摘要漏弹（v0.13 修复）
    const exclude = kind === 'pull'
      ? [...new Set([
        ...[...before.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([, v]) => v),
        ...(headBefore ? [headBefore] : []),
      ])]
      : [...new Set([...before.values(), ...(headBefore ? [headBefore] : [])])];
    const { entries, truncated } = await this.pullSummary.of(root, include, exclude);
    if (entries.length) {
      const stat = await this.statPullFiles(root, entries);
      this.post({ t: 'pullSummary', repoId: this.currentRepoId, kind, entries, truncated, stat });
    }
    this.channel.appendLine(`[summary] kind=${kind} new=${entries.length} include=${include.length} exclude=${exclude.length}`);
  }

  /**
   * 摘要文件的工作区现状（大小/修改时间）：rename 取新路径，唯一去重后并发 stat。
   * 只读尽力而为——不存在（历史删除/移动）、越界、超上限的文件不产生条目，UI 端按缺失显示 "—"。
   */
  private async statPullFiles(root: string, entries: { files: string[] }[]): Promise<Record<string, PullFileStat>> {
    const paths = new Set<string>();
    const MAX_STAT = 1000;   // 防御上限：500 提交 × 500 文件的理论极值不逐个 stat
    for (const e of entries) {
      for (const f of e.files) {
        if (paths.size >= MAX_STAT) break;
        paths.add(f.includes(RENAME_SEP) ? f.split(RENAME_SEP)[1] : f);
      }
      if (paths.size >= MAX_STAT) break;
    }
    const out: Record<string, PullFileStat> = {};
    await Promise.all([...paths].map(async p => {
      try {
        const st = await fs.promises.stat(this.safeJoin(root, p));
        if (st.isFile()) out[p] = { size: st.size, mtime: st.mtime.toISOString() };
      } catch { /* 不在工作区 / 路径异常：跳过 */ }
    }));
    return out;
  }

  // ---------- SourceTree 式后台自动获取（v0.13） ----------

  /** 按配置臂定时器：间隔分钟（1–1440 钳制），0/无效=关闭；每次调用先清旧定时器（设置变更即重臂） */
  private armAutoFetch(): void {
    if (this.fetchTimer) { clearInterval(this.fetchTimer); this.fetchTimer = undefined; }
    const mins = this.config.autoFetchInterval;
    if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return;
    const ms = Math.min(1440, Math.max(1, Math.round(mins))) * 60_000;
    this.fetchTimer = setInterval(() => this.autoFetchTick(), ms);
  }

  /**
   * 静默获取当前仓库全部远程：不打扰进度条/toast（与用户显式 Fetch 区分），失败仅记输出通道。
   * 拉到新提交后 refs 变化经指纹去重自然推送，分支 ↓n 徽标与提交图随之自动更新。
   */
  private autoFetchTick(): void {
    if (this.disposed || !this.runner || !this.currentRepoId) return;
    if (!this.lastState?.remotes.length) return;   // 无远程：本轮跳过
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    void this.runner.run(
      root, { kind: 'fetch', all: true, prune: this.config.fetchPrune, background: true }, opId,
      () => undefined,   // 不转发进度：后台行为保持安静
      () => '',
    ).then(outcome => {
      if (outcome.ok) {
        void this.refresh();   // 非强制：refs 有变指纹必变必推送，无新提交则去重免扰
      } else if (outcome.message !== 'cancelled') {
        this.channel.appendLine(`[autofetch] failed: ${(outcome.outputTail ?? outcome.message ?? '').slice(0, 200)}`);
      }
    });
  }

  /** 文件页操作（v0.14）：移动/重命名/删除——同 startOp 的进度与结果转发，但等待完成并返回 outcome */
  private async runFileOp(spec: OpSpec): Promise<{ ok: boolean; outputTail?: string }> {
    if (!this.runner || !this.currentRepoId) return { ok: false };
    const root = this.roots.get(this.currentRepoId)!;
    const opId = ++this.opSeq;
    const kind = spec.kind;
    this.post({ t: 'opProgress', opId, kind, text: '' });
    const outcome = await this.runner.run(
      root, spec, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind, text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t(`${kind}Done`) : this.t('opFailed', { op: this.t(kind) }),
    );
    this.post({ t: 'opResult', opId, kind, ok: outcome.ok, message: outcome.message, outputTail: outcome.outputTail });
    if (outcome.ok) {
      this.files?.invalidateTree(root);
      void this.refresh(true);
      void this.workStateNow().catch(() => undefined);
    }
    return outcome;
  }

  /** ls-files 判定跟踪状态（未跟踪项删除走磁盘而非 git rm） */
  private async isTracked(relPath: string): Promise<boolean> {
    if (!this.files) return true;
    return this.files.trackedOf(this.currentRoot(), relPath);
  }

  /** explorer 右键「查看文件历史」：定位到所属仓库并通知 webview 选中该路径 */
  revealInFiles(absPath: string): void {
    for (const r of this.repos) {
      const root = this.roots.get(r.id);
      if (!root || !(absPath === root || absPath.startsWith(root + path.sep))) continue;
      const rel = path.relative(root, absPath).replace(/\\/g, '/');
      this.pendingFilesReveal.push(rel);
      if (!this.ready) return;   // bootstrap 完成后统一 flush
      if (r.id === this.currentRepoId) this.flushFilesReveal();
      else void this.selectRepo(r.id).then(() => this.flushFilesReveal());
      return;
    }
  }

  private flushFilesReveal(): void {
    while (this.pendingFilesReveal.length) {
      this.post({ t: 'filesReveal', path: this.pendingFilesReveal.shift()! });
    }
  }

  /** 同仓库同 kind 网络操作去重登记（F4/Issue #6）：进行中/排队中时忽略重复点击 */
  private netInFlight = new Map<string, Set<string>>();

  /** 操作后校验警告文案（Issue #6 后续）：按 reason 选 i18n 键与参数 */
  private verifyWarnText(kind: string, v: VerifyResult): string {
    switch (v.reason) {
      case 'behind': return this.t('verifyWarnPull', { ref: v.ref ?? '', n: String(v.n ?? 0) });
      case 'ahead': return this.t('verifyWarnPush', { ref: v.ref ?? '', n: String(v.n ?? 0) });
      case 'headUnchanged': return this.t('verifyWarnHeadUnchanged');
      case 'headMismatch': return this.t('verifyWarnHeadMismatch');
      case 'tagMissing': return this.t('verifyWarnTagMissing', { name: v.name ?? '' });
      case 'tagExists': return this.t('verifyWarnTagExists', { name: v.name ?? '' });
      case 'remoteDrift': return this.t('verifyWarnRemoteDrift', { ref: v.ref ?? '' });
      default: return this.t(`${kind}Done`);
    }
  }

  private startOp(spec: OpSpec): void {
    if (!this.runner || !this.currentRepoId) return;
    const root = this.roots.get(this.currentRepoId)!;
    // F4（Issue #6）：网络操作同类去重——慢网络下连点 Fetch/Pull/Push 只跑一个，
    // 不再向串行队列堆积重复 op（旧版每次点击都排一个，队列被同一操作刷满）
    const isNet = spec.kind === 'fetch' || spec.kind === 'pull' || spec.kind === 'push';
    if (isNet) {
      const inflight = this.netInFlight.get(root);
      if (inflight?.has(spec.kind)) return;
      if (inflight) inflight.add(spec.kind);
      else this.netInFlight.set(root, new Set([spec.kind]));
    }
    const releaseKind = (): void => {
      const s = this.netInFlight.get(root);
      if (!s) return;
      s.delete(spec.kind);
      if (!s.size) this.netInFlight.delete(root);
    };
    const opId = ++this.opSeq;
    const kind = spec.kind;
    const label = this.t(kind);
    // 立即播报"进行中"（不等首条 --progress 输出），按钮随即进入繁忙态
    this.post({ t: 'opProgress', opId, kind, text: '' });
    const refsBefore = kind === 'fetch' || kind === 'pull' ? this.snapshotRefs() : undefined;
    const headBefore = kind === 'pull' ? this.lastState?.head.sha : undefined;   // 摘要范围：pull 前后 HEAD 差
    // F3（Issue #6）：pull 的"已是最新"反馈带上游分支名——拉错分支/远端时一眼可见
    const upstreamBefore = kind === 'pull' ? this.lastState?.branches.find(b => b.isHead)?.upstream : undefined;
    void this.runner.run(
      root, spec, opId,
      (text, pct) => this.post({ t: 'opProgress', opId, kind, text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
      ok => ok ? this.t(`${kind}Done`) : this.t('opFailed', { op: label }),
    ).then(async outcome => {
      try {
        if (outcome.message === 'cancelled') {
          this.post({ t: 'opResult', opId, kind, ok: false, message: this.t('opCancelled') });
          return;
        }
        // 结果细化：让"点了但没变化"也有明确反馈（v0.7.1）
        let message = outcome.message;
        let verify: 'pass' | 'warn' | 'unknown' | undefined;
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
            // F3（Issue #6）："已是最新"带上游名便于诊断拉错分支/远端；
            // 矛盾校验（上游领先却未合并）已由下方 OpVerifier 统一承载
            message = upstreamBefore ? this.t('pullUpToDateWith', { ref: upstreamBefore }) : this.t('pullUpToDate');
          } else if (kind === 'push') {
            message = `${this.t('pushDone')}：${spec.branch ?? 'HEAD'} → ${spec.remote ?? 'origin'}`;
          }
          // 操作后快速校验（Issue #6 后续）：退出码 0 后按意图核对仓库状态，
          // 假成功（拉错分支/推错分支/未合并/HEAD 未按预期变化）显式警示；探针 fail-open
          if (kind !== 'fetch' && this.verifier && this.config.opVerify !== 'off') {
            const v = await this.verifier.verify(root, spec, {}, this.config.opVerify === 'deep' ? 'deep' : 'quick');
            if (v.verdict === 'warn') {
              message = this.verifyWarnText(kind, v);
              verify = 'warn';
            } else if (v.verdict !== 'skip') {
              verify = v.verdict;
            }
          }
        } else if (outcome.stalled) {
          // F2（Issue #6）：无输出看门狗触发——连接停滞快速失败并明示原因，重试即新连接
          message = this.t('netStalled');
        }
        this.post({
          t: 'opResult', opId, kind, ok: outcome.ok,
          message, outputTail: outcome.outputTail, verify,
        });
        if (outcome.ok) {
          this.files?.invalidateTree(root);   // commit/checkout/reset 等改变 index/HEAD → 文件页目录缓存失效
          void this.refresh(true);   // 操作成功：强制重推（fetch/pull/push/checkout/reset 后表格必刷新）
          void this.workStateNow().catch(() => undefined);
          if (refsBefore && (kind === 'fetch' || kind === 'pull')) {
            void this.collectPullSummary(root, kind, refsBefore, headBefore).catch(() => undefined);
          }
        } else if (kind === 'pull') {
          // pull 失败（含冲突：git 以非零退出）也刷工作副本——前端据此弹冲突横幅引导（R3）
          void this.workStateNow().catch(() => undefined);
        }
      } finally {
        releaseKind();
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
      // F1（Issue #6）：不传 remote/branch，按分支级配置拉取（与原生 git pull 语义一致）
      this.startOp({ kind: 'pull', strategy: this.config.defaultPullStrategy });
    }
    if (kind === 'push') {
      this.startOp({ kind: 'push', remote, branch: head?.branch ?? 'HEAD', setUpstream: !upstream });
    }
  }

  // ---------- 工作副本（Commit 功能，设计方案 v1.3） ----------

  /** 命令面板「提交更改」：打开主界面并切到工作副本视图 */
  openWorkView(): void {
    // bootstrap 已开始 ⇒ webview 在线，直接推送（不依赖 git）；否则排队随首个 ready 发出
    if (this.bootstrapped) this.post({ t: 'showWork' });
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
      mergeActive: wc.mergeActive,
      headShortSha: head?.shortSha ?? '',
      headSubject: head?.subject ?? '',
      headDate: head?.date ?? '',
      moveDetect: detectMove(wc.unstaged),
    };
    this.lastWorkEntries = wc;
    const json = JSON.stringify(state);
    if (json !== this.lastWorkJson) {
      this.lastWorkJson = json;
      this.post({ t: 'workState', state });
      // 联动侧栏树：脏计数变化 → 活动栏图标角标随 tree.refresh() 更新
      GraphPanel.onDidStateChange.fire();
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
      if (outcome.ok) {
        this.files?.invalidateTree(root);   // stage/unstage/discard 等改变 index → 文件页目录缓存失效
        void this.workStateNow();
      }
    });
  }

  private workStagePaths(paths: string[], stage: boolean): void {
    if (!paths.length) return;
    this.startWorkOp({ kind: stage ? 'stage' : 'unstage', paths });
  }

  /**
   * 冲突二选一（git 级 ours/theirs）：checkout 侧 + add。
   * v0.10（决议 #2）：全部解决后不再自动完成合并提交——前端弹「完成合并」确认，经 merge.finish 走 commitNoEdit / rebase --continue。
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
      await this.workStateNow().catch(() => undefined);
    });
  }

  // ---------- 合并解决器（v0.10） ----------

  /** 语义侧 → git ours 映射：merge 我=:2/--ours；rebase 我=:3/--theirs（语义反转，设计方案 §4.6） */
  private sideToOurs(sideTheirs: boolean, root: string): boolean {
    const kind = this.service?.mergeKindOf(root) ?? 'merge';
    return semanticToOurs(kind, sideTheirs);
  }

  /** 合并会话：三栏数据 / 二进制 / 超限三态（XY 码判删除侧，contentAt 取 stage 内容） */
  private async mergeSessionOf(relPath: string): Promise<MergeSessionAny> {
    if (!this.service || !this.currentRepoId) throw new Error('not ready');
    const root = this.currentRoot();
    const kind = this.service.mergeKindOf(root);
    const labels = this.service.mergeLabelsOf(root, kind);
    const code = (this.lastWorkEntries?.conflicts ?? []).find(c => c.path === relPath)?.conflictCode ?? 'UU';
    // XY 码的 us/them 语义与 --ours 一致：rebase 时随 stage 一并反转
    const usDeleted = code === 'DU' || code === 'DD';
    const themDeleted = code === 'UD' || code === 'DD';
    const rebase = kind === 'rebase';
    const mineStage = rebase ? 3 : 2;
    const theirsStage = rebase ? 2 : 3;
    const mineGone = code === 'DD' ? true : (rebase ? themDeleted : usDeleted);
    const theirsGone = code === 'DD' ? true : (rebase ? usDeleted : themDeleted);
    const [mineRaw, theirsRaw, baseRaw] = await Promise.all([
      mineGone ? Promise.resolve(null) : this.service.contentAt(root, ':' + mineStage, relPath),
      theirsGone ? Promise.resolve(null) : this.service.contentAt(root, ':' + theirsStage, relPath),
      this.service.contentAt(root, ':1', relPath),
    ]);
    const mine = mineRaw ?? '';
    const theirs = theirsRaw ?? '';
    const mineBytes = Buffer.byteLength(mine, 'utf8');
    const theirsBytes = Buffer.byteLength(theirs, 'utf8');
    const mineLines = mine ? mine.split('\n').length : 0;
    const theirsLines = theirs ? theirs.split('\n').length : 0;
    // 超限（决议 #5）：显式警告由前端渲染，此处带数据
    if (Math.max(mineBytes, theirsBytes) > MERGE_MAX_BYTES || Math.max(mineLines, theirsLines) > MERGE_MAX_LINES) {
      return { path: relPath, binary: false, tooLarge: true, lines: Math.max(mineLines, theirsLines), bytes: Math.max(mineBytes, theirsBytes) };
    }
    // 二进制：现存侧内容含 NUL → 只二选一 + 系统预览
    const NUL = String.fromCharCode(0);
    if ((!mineGone && mine.includes(NUL)) || (!theirsGone && theirs.includes(NUL))) {
      return {
        path: relPath, kind, labels, binary: true,
        deletedSide: code === 'DD' ? 'theirs' : (mineGone ? 'mine' : theirsGone ? 'theirs' : undefined),
        mineSize: mineGone ? undefined : mineBytes,
        theirsSize: theirsGone ? undefined : theirsBytes,
      };
    }
    let result = '';
    try { result = fs.readFileSync(this.safeJoin(root, relPath), 'utf8'); } catch { /* DD：工作副本可能已被删 */ }
    const deletedSide = code === 'DD' ? undefined : (mineGone ? 'mine' : theirsGone ? 'theirs' : undefined);
    return {
      path: relPath, kind, labels, binary: false,
      base: baseRaw || undefined,
      mine, theirs, result,
      deletedSide,
      mergeMsg: kind === 'merge' ? this.service.mergeMsgOf(root) : undefined,
    };
  }

  /** 语义侧二选一（我的/他人）：映射 --ours/--theirs 后走既有 resolveConflict 队列 */
  private mergeResolveSide(relPath: string, sideTheirs: boolean): void {
    const root = this.currentRoot();
    this.workResolveConflict([relPath], this.sideToOurs(sideTheirs, root));
  }

  /** 以合并后的代码为准：原子写回工作副本 + add（决议 #2：写回即暂存，完成合并在 merge.finish 确认后） */
  private async mergeSaveFile(relPath: string, content: string): Promise<{ ok: true }> {
    const abs = this.safeJoin(this.currentRoot(), relPath);
    const tmp = abs + '.gitboard-merge';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, abs);
    this.startWorkOp({ kind: 'stage', paths: [relPath] });
    return { ok: true };
  }

  /** 一方删除场景：选中的语义侧若被删 = 采纳删除（git rm）；仍存在 = 取该侧内容（checkout+add）。DD 双删只剩采纳删除 */
  private mergeDeleteAccept(relPath: string, sideTheirs: boolean): void {
    const root = this.currentRoot();
    const code = (this.lastWorkEntries?.conflicts ?? []).find(c => c.path === relPath)?.conflictCode ?? 'UU';
    const rebase = (this.service?.mergeKindOf(root) ?? 'merge') === 'rebase';
    const usDeleted = code === 'DU' || code === 'DD';
    const themDeleted = code === 'UD' || code === 'DD';
    const mineGone = code === 'DD' ? true : (rebase ? themDeleted : usDeleted);
    const theirsGone = code === 'DD' ? true : (rebase ? usDeleted : themDeleted);
    const sideGone = sideTheirs ? theirsGone : mineGone;
    if (sideGone) this.startWorkOp({ kind: 'resolveDelete', paths: [relPath] });
    else this.workResolveConflict([relPath], this.sideToOurs(sideTheirs, root));
  }

  /** 完成合并（决议 #2 确认后）：merge→commit --no-edit；rebase→rebase --continue */
  private async mergeFinish(): Promise<{ ok: true }> {
    const root = this.currentRoot();
    const kind = this.service?.mergeKindOf(root) ?? 'other';
    if (kind === 'other') throw new Error(this.t('mergeFinishUnsupported'));
    this.startOp({ kind: kind === 'rebase' ? 'mergeContinue' : 'commitNoEdit', rebase: kind === 'rebase' });
    return { ok: true };
  }

  /** 中止合并/变基：还原到操作前（带前端二次确认） */
  private async mergeAbort(): Promise<{ ok: true }> {
    const root = this.currentRoot();
    const kind = this.service?.mergeKindOf(root) ?? 'other';
    if (kind === 'other') throw new Error(this.t('mergeFinishUnsupported'));
    this.startOp({ kind: 'mergeAbort', rebase: kind === 'rebase' });
    return { ok: true };
  }

  /** 二进制预览：stage 内容写临时文件后用系统默认程序打开（文件名不带用户输入，扩展名白名单化） */
  private async mergePreviewBinary(relPath: string, sideTheirs: boolean): Promise<null> {
    if (!this.service || !this.currentRepoId) return null;
    const root = this.currentRoot();
    const kind = this.service.mergeKindOf(root);
    const stage = semanticToOurs(kind, sideTheirs) ? 2 : 3;   // 语义侧→stage2/3（merge 我=:2；rebase 我=:3）
    const content = await this.service.contentAt(root, ':' + stage, relPath);
    if (content == null) { void vscode.window.showWarningMessage(this.t('mergePreviewMissing')); return null; }
    const rawExt = path.extname(relPath).slice(1);
    const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? '.' + rawExt.toLowerCase() : '';
    const tmp = path.join(os.tmpdir(), `gitboard-preview-${Date.now()}${safeExt}`);
    fs.writeFileSync(tmp, content, 'utf8');
    const plat = process.platform;
    try {
      // 直接以 explorer 打开（系统默认程序）：不经 cmd/start —— cmd 中转是企业 EDR 的常见告警模式
      if (plat === 'win32') spawn('explorer', [tmp], { detached: true, stdio: 'ignore' }).unref();
      else if (plat === 'darwin') spawn('open', [tmp], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [tmp], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      this.channel.appendLine(`[merge-preview] failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    return null;
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

  /** 提交（可 all=/amend=/push= 链式推送）；成功后清草稿并整图刷新；dirty=提交后脏文件数（前端决定是否显示推送询问条） */
  private async workCommit(args: any): Promise<{ ok: true; shortSha?: string; dirty?: number }> {
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
    // 校验基准（Issue #6 后续）：提交前 HEAD——commit 判定"HEAD 必须前进"
    const headBefore = (await this.service!.headShaOf(root).catch(() => null)) ?? undefined;
    let outcome;
    try {
      outcome = await this.runner!.run(root, { kind: 'commit', messageFile: file, amend }, opId,
        (text, pct) => this.post({ t: 'opProgress', opId, kind: 'commit', text: text.length > 120 ? text.slice(0, 117) + '…' : text, pct }),
        ok => ok ? this.t(amend ? 'amendDone' : 'commitDone') : this.t('opFailed', { op: this.t('commit') }),
      );
    } finally {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
    // 操作后校验（Issue #6 后续）：HEAD 未前进 = 假成功警示（fail-open）
    let verify: 'pass' | 'warn' | 'unknown' | undefined;
    let commitMessage = outcome.message;
    if (outcome.ok && this.verifier && this.config.opVerify !== 'off') {
      const v = await this.verifier.verify(root, { kind: 'commit' }, { headBefore }, this.config.opVerify === 'deep' ? 'deep' : 'quick');
      if (v.verdict === 'warn') {
        commitMessage = this.verifyWarnText('commit', v);
        verify = 'warn';
      } else if (v.verdict !== 'skip') {
        verify = v.verdict;
      }
    }
    this.post({ t: 'opResult', opId, kind: 'commit', ok: outcome.ok, message: commitMessage, outputTail: outcome.outputTail, verify });
    if (!outcome.ok) throw new Error(outcome.message ?? 'commit failed');

    await this.context.globalState.update(`gitboard.commitDraft:${this.currentRepoId}`, undefined);
    this.files?.invalidateTree(root);   // 提交改变 HEAD/index → 文件页目录缓存失效
    void this.refresh(true);   // 提交成功：强制重推
    // 提交后的即时状态：dirty 随响应返回，前端据此决定是否显示推送询问条
    // （工作区已干净时干净空态自带「推送」按钮，绿色询问条不再叠加）
    const wst = await this.workStateNow().catch(() => undefined);
    if (push) this.quickOp('push');
    const head = await this.service!.headCommitOf(root);
    return { ok: true, shortSha: head?.shortSha, dirty: wst?.dirtyCount };
  }

  /** 路径级变更清单（AI 降级上下文）：与 buildCommitContext 同口径——暂存非空取暂存，否则全部更改；untracked 归一为 A */
  private changedEntriesFromWork(): { status: string; path: string }[] {
    const w = this.lastWorkEntries;
    if (!w) return [];
    const src = w.staged.length ? w.staged : [...w.staged, ...w.unstaged];
    return src.map(e => ({ status: e.untracked ? 'A' : (e.staged ?? e.unstaged ?? 'M'), path: e.path }));
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
      // 路径级变更清单（与 buildCommitContext 同口径：暂存非空取暂存，否则全部更改）——零 git 调用
      const entries = this.changedEntriesFromWork();
      let pathFallback = false;
      let ctx: Awaited<ReturnType<GitService['buildCommitContext']>>;
      try {
        ctx = await this.service!.buildCommitContext(root, { learnFromHistory: this.config.aiLearnFromHistory, useInstructions });
        if (!diffContentUsable(ctx.stagedDiff, entries.length)) pathFallback = true;   // 内容全是省略标记（二进制/锁文件/超长行）
      } catch (e) {
        // 差异过大/超时（暂存大文件为主因）：降级为"文件名 + 目录结构"推断
        if (!entries.length) throw e;   // 连清单都没有（面板未刷新过）：维持原失败提示
        this.channel.appendLine(`[ai] context build failed → path fallback (${entries.length} files): ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        const recent = this.config.aiLearnFromHistory ? await this.service!.recentMessages(root, 10) : [];
        const instructions = useInstructions ? await this.service!.collectInstructions(root) : [];
        ctx = {
          stagedSummary: formatEntryList(entries),
          stagedDiff: '',
          recentSubjects: recent.map(m => m.subject),
          instructions,
          diffTruncated: false,
        };
        pathFallback = true;
      }
      const pctx: CommitPromptCtx & { useInstructions?: boolean } = {
        ...ctx,
        fileTree: buildFileTree(entries) || undefined,
        diffUsable: !pathFallback,
        instructions: useInstructions ? ctx.instructions : [],
        language: this.config.aiLanguage,
      };
      const prompt = `${buildSystemPrompt(pctx)}\n\n${buildUserPrompt(pctx)}`;
      this.channel.appendLine(`[ai] model=${model.name} instructions=${pctx.instructions.length} diffChars=${ctx.stagedDiff.length} summaryChars=${ctx.stagedSummary.length} usable=${!pathFallback} files=${entries.length}`);
      armWatchdog();
      const res = await model.sendRequest([userMessage(vscode, prompt)], {}, cts.token);
      for await (const chunk of res.text) {
        armWatchdog();
        this.post({ t: 'aiChunk', text: chunk });
      }
      this.post({ t: 'aiDone', model: model.name, instructions: pctx.instructions.length, fallback: pathFallback });
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

  // ---------- 工程切换（v0.11：globalState 持久化的跨工作区切换目标） ----------

  private readProjects(): ProjectInfo[] {
    const raw = this.context.globalState.get<any[]>('gitboard.projects') ?? [];
    const out: ProjectInfo[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (!r || typeof r.path !== 'string' || !r.path.trim()) continue;
      const dir = path.resolve(r.path);
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: typeof r.id === 'string' && r.id ? r.id : repoIdOf(dir),
        name: String(r.name ?? '').trim().slice(0, 80) || path.basename(dir) || dir,
        path: dir,
      });
    }
    return out.slice(0, 50);
  }

  private samePath(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  /** ready 事件的附加字段：面板高度百分比 + 工程列表/命中标记 + 工作区根路径 */
  private readyExtras(): { detailPct?: number; projects: ProjectInfo[]; activeProjectIds: string[]; workspaceFolders: string[]; filesLayout?: { paneW: number; cols: number[] }; sideCollapsed?: boolean; workFilesW?: number } {
    const projects = this.readProjects();
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const activeProjectIds = projects.filter(p => folders.some(f => this.samePath(f, p.path))).map(p => p.id);
    const detailPct = this.context.globalState.get<number>('gitboard.detailPct');
    const filesLayout = this.context.globalState.get<{ paneW: number; cols: number[] }>('gitboard.filesLayout');
    const sideCollapsed = this.context.globalState.get<boolean>('gitboard.sideCollapsed');
    const workLayout = this.context.globalState.get<{ filesW?: number }>('gitboard.workLayout');
    return {
      detailPct: typeof detailPct === 'number' && Number.isFinite(detailPct) ? detailPct : undefined,
      projects,
      activeProjectIds,
      workspaceFolders: folders,
      filesLayout: filesLayout && typeof filesLayout.paneW === 'number' ? filesLayout : undefined,
      sideCollapsed: sideCollapsed === true ? true : undefined,
      workFilesW: typeof workLayout?.filesW === 'number' && Number.isFinite(workLayout.filesW) ? workLayout.filesW : undefined,
    };
  }

  private async saveProjects(list: ProjectInfo[]): Promise<void> {
    await this.context.globalState.update('gitboard.projects', list.slice(0, 50));
    const { projects, activeProjectIds } = this.readyExtras();
    this.post({ t: 'projectsChanged', projects, activeProjectIds });
  }

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
   * 不经 cmd.exe——cmd 中转是企业 EDR 的常见告警模式，直接 explorer 与各应用"在资源管理器
   * 中显示"同形态。explorer 正常情况退出码为 1，仅 error 事件（ENOENT 等）才回退 revealFileInOS。
   * 传参形态 explorer 随 Windows 版本漂移（三轮实测见 revealPath.ts 头注释）：默认 classic =
   * 单参数 + windowsVerbatimArguments（命令行原样 `explorer /select,C:\path with spaces`，
   * 自 XP 起通用）；可用 gitboard.revealSelectStyle 切换 separate/quoted 兜底异构构建。
   * 长路径（>259）任何形态皆挂，仍走祖先降级。
   */
  private async revealInFileManager(target: string): Promise<void> {
    const fallback = (): void => {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target))
        .then(() => undefined, () => undefined);
    };
    try {
      if (process.platform === 'win32') {
        // 无 shell 参与，天然无元字符解释问题；仅剥离文件名中的引号防 explorer 参数解析错乱。
        const p = revealableAncestor(target.replace(/"/g, ''));
        if (!p) { fallback(); return; }
        const style = vscode.workspace.getConfiguration('gitboard').get<RevealSelectStyle>('revealSelectStyle') ?? 'classic';
        const form = revealSpawnForm(p, style);
        const child = spawn('explorer', form.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: form.verbatim });
        child.once('error', () => fallback());
        child.unref();
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
