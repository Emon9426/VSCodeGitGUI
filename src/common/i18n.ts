/**
 * 运行时文案 —— 扩展宿主与 Webview 共享同一份字典（设计方案第 11 节）。
 * t(key, params)：{n} 占位符替换。
 */

export type Lang = 'zh-CN' | 'en';

const zh: Record<string, string> = {
  app: 'GitGraph',
  loading: '加载中…',
  refresh: '刷新',
  cancel: '取消',
  ok: '确定',
  yes: '是',
  no: '否',
  confirm: '确认',
  close: '关闭',
  copy: '复制',
  copySha: '复制完整 SHA',
  copySubject: '复制提交说明',
  copyBranchName: '复制分支名',
  copyPath: '复制路径',
  error: '错误',

  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  reset: '重置',
  settings: '设置',
  filterAll: '全部',
  running: '{op} 进行中…',

  repos: '仓库',
  branches: '分支',
  remotes: '远程',
  tags: '标签',

  colGraph: '图形',
  colMessage: '提交说明',
  colAuthor: '作者',
  colSha: 'SHA',
  colTime: '时间',

  detail: '详情',
  author: '作者',
  committer: '提交者',
  authorDate: '作者时间',
  commitDate: '提交时间',
  message: '提交注释',
  changedFiles: '变更文件',
  noSelection: '点击提交行查看详情',
  binaryFile: '二进制文件，请在差异编辑器中查看工作区副本',
  tooLargeDiff: '文件较大，请使用内置差异编辑器查看',
  openInDiffEditor: '在差异编辑器中打开',
  openFile: '打开工作区文件',
  openAtRevision: '查看此版本（只读）',
  revealInFM: '在文件管理器中显示',
  mergeDiffNote: '合并提交按第一父提交口径显示差异',

  checkout: '检出',
  checkoutDetached: '检出此提交（分离 HEAD）',
  checkoutAs: '检出为新的本地分支…',
  branchNameLabel: '新分支名',
  resetToThisCommit: '重置到此提交…',
  resetTitle: '重置仓库到 {sha}',
  modeSoft: 'soft — 保留工作区与索引',
  modeMixed: 'mixed — 保留工作区，重置索引',
  modeHard: 'hard — 丢弃全部未提交变更',
  hardWarning: '当前有 {n} 个文件存在未提交修改，hard 重置将永久丢弃这些变更！',
  hardConfirm: '我已知晓，执行 hard 重置',

  pullThis: '拉取此分支',
  pushThis: '推送此分支',
  fetchRemote: '获取此远程',
  fetchAll: '获取全部远程',

  fetchDone: '获取完成',
  pullDone: '拉取完成',
  pushDone: '推送完成',
  resetDone: '重置完成',
  checkoutDone: '检出完成',
  opCancelled: '操作已取消',
  opFailed: '{op} 失败',
  viewOutput: '查看完整输出',

  pushNoUpstream: '当前分支没有上游分支。是否推送并在远程创建同名分支？',
  pullNoUpstream: '当前分支没有上游分支，无法拉取。',

  noCommits: '该仓库尚无提交',
  noCommitsHint: '在终端提交第一个提交后，此处将显示提交图。',
  noRepos: '当前工作区未发现 Git 仓库',
  noReposHint: '请先打开一个包含 Git 仓库的文件夹。',
  gitNotFound: '未找到可用的 git 可执行文件',
  gitNotFoundHint: '请安装 Git 或在设置中指定 gitgraph.gitPath。',

  loadMore: '继续加载更多',
  loadedCount: '已加载 {n} 条提交',
  loadLimitReached: '已达到自动加载上限（{n}），点击下方按钮继续加载',

  detachedHead: '分离 HEAD',
  dirtyCount: '{n} 个未提交修改',
  filesTruncated: '文件列表过长已截断',

  justNow: '刚刚',
  minAgo: '{n} 分钟前',
  hourAgo: '{n} 小时前',
  dayAgo: '{n} 天前',
  weekAgo: '{n} 周前',
  relativeOld: '{n} 年前',
};

const en: Record<string, string> = {
  app: 'GitGraph',
  loading: 'Loading…',
  refresh: 'Refresh',
  cancel: 'Cancel',
  ok: 'OK',
  yes: 'Yes',
  no: 'No',
  confirm: 'Confirm',
  close: 'Close',
  copy: 'Copy',
  copySha: 'Copy full SHA',
  copySubject: 'Copy commit subject',
  copyBranchName: 'Copy branch name',
  copyPath: 'Copy path',
  error: 'Error',

  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  reset: 'Reset',
  settings: 'Settings',
  filterAll: 'All',
  running: '{op} in progress…',

  repos: 'Repositories',
  branches: 'Branches',
  remotes: 'Remotes',
  tags: 'Tags',

  colGraph: 'Graph',
  colMessage: 'Message',
  colAuthor: 'Author',
  colSha: 'SHA',
  colTime: 'Time',

  detail: 'Details',
  author: 'Author',
  committer: 'Committer',
  authorDate: 'Author date',
  commitDate: 'Commit date',
  message: 'Message',
  changedFiles: 'Changed files',
  noSelection: 'Click a commit row to see details',
  binaryFile: 'Binary file. Open the working copy in the diff editor instead.',
  tooLargeDiff: 'File too large. Use the built-in diff editor.',
  openInDiffEditor: 'Open in diff editor',
  openFile: 'Open working file',
  openAtRevision: 'Open this revision (read-only)',
  revealInFM: 'Reveal in file manager',
  mergeDiffNote: 'Merge commits are diffed against their first parent',

  checkout: 'Checkout',
  checkoutDetached: 'Checkout this commit (detached HEAD)',
  checkoutAs: 'Checkout as new local branch…',
  branchNameLabel: 'New branch name',
  resetToThisCommit: 'Reset to this commit…',
  resetTitle: 'Reset repository to {sha}',
  modeSoft: 'soft — keep working tree and index',
  modeMixed: 'mixed — keep working tree, reset index',
  modeHard: 'hard — discard all uncommitted changes',
  hardWarning: '{n} files have uncommitted changes. A hard reset will discard them permanently!',
  hardConfirm: 'I understand, run hard reset',

  pullThis: 'Pull this branch',
  pushThis: 'Push this branch',
  fetchRemote: 'Fetch this remote',
  fetchAll: 'Fetch all remotes',

  fetchDone: 'Fetch completed',
  pullDone: 'Pull completed',
  pushDone: 'Push completed',
  resetDone: 'Reset completed',
  checkoutDone: 'Checkout completed',
  opCancelled: 'Operation cancelled',
  opFailed: '{op} failed',
  viewOutput: 'View full output',

  pushNoUpstream: 'The current branch has no upstream. Push and create the branch on the remote?',
  pullNoUpstream: 'The current branch has no upstream; cannot pull.',

  noCommits: 'This repository has no commits yet',
  noCommitsHint: 'The graph will appear here after the first commit.',
  noRepos: 'No Git repository found in this workspace',
  noReposHint: 'Open a folder that contains a Git repository first.',
  gitNotFound: 'Git executable not found',
  gitNotFoundHint: 'Install Git, or set gitgraph.gitPath in settings.',

  loadMore: 'Load more',
  loadedCount: '{n} commits loaded',
  loadLimitReached: 'Auto-load limit reached ({n}). Use the button below to continue.',

  detachedHead: 'Detached HEAD',
  dirtyCount: '{n} uncommitted changes',
  filesTruncated: 'File list truncated',

  justNow: 'just now',
  minAgo: '{n} min ago',
  hourAgo: '{n} hours ago',
  dayAgo: '{n} days ago',
  weekAgo: '{n} weeks ago',
  relativeOld: '{n} years ago',
};

const dicts: Record<Lang, Record<string, string>> = { 'zh-CN': zh, en };

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function createT(lang: Lang): Translate {
  const dict = dicts[lang];
  return (key, params) => {
    let s = dict[key] ?? dicts.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
    }
    return s;
  };
}

/** auto 时依据 VS Code 界面语言判定 */
export function resolveLang(setting: 'auto' | 'zh-CN' | 'en', vscodeLanguage: string): Lang {
  if (setting === 'zh-CN' || setting === 'en') return setting;
  return vscodeLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
