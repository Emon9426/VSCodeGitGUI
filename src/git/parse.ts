/**
 * git 输出解析器（纯函数，设计方案 13.1 单测对象）。
 */
import { RENAME_SEP, MERGE_MAX_LINES, MERGE_MAX_BYTES } from '../common/models';
import type { Commit, RefChip, BranchInfo, TagInfo, RemoteGroup, FileChange, FileStatus, UnifiedDiff, DiffHunk, DiffLine, FileEntry, FileHistoryItem, PathChain } from '../common/models';

export const FS = '\x1f';   // 字段分隔符
export const RS = '\x1e';   // 记录分隔符

/** %H %h %P an ae ad cn ce cd D s b —— 13 字段 */
export const LOG_FORMAT =
  `%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%ad${FS}%cn${FS}%ce${FS}%cd${FS}%D${FS}%s${FS}%b${RS}`;

/** Pull/Fetch 摘要格式：sha/短sha/作者/日期/主题 5 字段；记录后随 --name-status 文件行 */
export const SUMMARY_FORMAT = `%H${FS}%h${FS}%an${FS}%ad${FS}%s${RS}`;

export interface SummaryRecord {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  filesTruncated: boolean;
}

/** 解析 `log --pretty=format:SUMMARY_FORMAT --name-status` 输出（每条记录后跟文件行直到记录分隔符） */
const SUMMARY_HEAD_RE = /^([0-9a-f]{40})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f(.*)$/;

/**
 * 解码 git C 风格引号路径（"…\357\274\210…" → UTF-8 文本）。
 * core.quotepath=false 已消除常规中文转义，但含 `"`、`\` 或控制符的路径
 * 仍被 git 强制引号转义（\ooo 八进制 / \n \t \\ \" 等），此处按字节还原后 UTF-8 解码。
 * 引号内只会出现 ASCII 转义序列，逐字节收集安全；非引号包裹的输入原样返回。
 */
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

export function unescapeGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length;) {
    const c = inner[i];
    if (c === '\\') {
      const oct = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 4; continue; }
      const simple = C_ESCAPES[inner[i + 1]];
      if (simple !== undefined) { bytes.push(simple); i += 2; continue; }
    }
    // 防御：非转义字符（不应出现在合法引号路径中）按原字节透传
    const buf = Buffer.from(c, 'utf8');
    for (const b of buf) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 解析 `log --pretty=format:SUMMARY_FORMAT --name-status` 输出（逐行状态机）：
 * pretty 行（sha\x1f…\x1e）开启新记录，其后形如 "M\tpath" / "R100\told\tnew" 的行即变更文件，
 * 条目间的空行自然跳过。
 */
export function parseSummaryLog(out: string, maxFiles: number): SummaryRecord[] {
  const records: SummaryRecord[] = [];
  if (!out) return records;
  let cur: SummaryRecord | null = null;
  for (const line of out.split('\n')) {
    const m = line.replace(/\x1e$/, '').match(SUMMARY_HEAD_RE);
    if (m) {
      cur = { sha: m[1], shortSha: m[2], author: m[3], date: m[4], subject: m[5], files: [], filesTruncated: false };
      records.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.split('\t');
    if (t.length < 2) continue;
    const status = t[0][0];
    if (!'AMDRCT'.includes(status)) continue;
    if (cur.files.length >= maxFiles) { cur.filesTruncated = true; continue; }
    // 引号转义路径（quotepath 残留 / 特殊字符）解码；重命名两端各自解码
    const oldP = unescapeGitPath(t[1]);
    const newP = (status === 'R' || status === 'C') ? unescapeGitPath(t[2] ?? t[1]) : undefined;
    cur.files.push(newP !== undefined ? oldP + RENAME_SEP + newP : oldP);
  }
  return records;
}

export interface LogParseCtx {
  localBranches?: Set<string>;
  remoteBranches?: Set<string>;
}

export function parseLog(out: string, ctx: LogParseCtx = {}): Commit[] {
  const commits: Commit[] = [];
  if (!out) return commits;
  const records = out.split(RS);
  for (let rec of records) {
    if (rec.startsWith('\n')) rec = rec.slice(1);
    if (!rec) continue;
    const f = rec.split(FS);
    if (f.length < 12 || !f[0]) continue;
    commits.push({
      sha: f[0],
      shortSha: f[1],
      parents: f[2] ? f[2].split(' ').filter(Boolean) : [],
      author: { name: f[3], email: f[4], date: f[5] },
      committer: { name: f[6], email: f[7], date: f[8] },
      subject: f[10],
      body: f[11].replace(/\n+$/, ''),
      refs: parseDecorations(f[9], ctx),
    });
  }
  return commits;
}

/** %D 装饰串 → chips；优先用已知 refs 集合分类，未知名称按含 '/' 回退为远程 */
export function parseDecorations(d: string, ctx: LogParseCtx = {}): RefChip[] {
  if (!d) return [];
  const chips: RefChip[] = [];
  for (const raw of d.split(', ')) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok.startsWith('HEAD -> ')) {
      chips.push({ name: tok.slice(8), kind: 'head', isHead: true });
    } else if (tok === 'HEAD') {
      chips.push({ name: 'HEAD', kind: 'head', isHead: true });
    } else if (tok.startsWith('tag: ')) {
      chips.push({ name: tok.slice(5), kind: 'tag' });
    } else if (ctx.localBranches?.has(tok)) {
      chips.push({ name: tok, kind: 'head' });
    } else if (ctx.remoteBranches?.has(tok)) {
      chips.push({ name: tok, kind: 'remote' });
    } else {
      chips.push({ name: tok, kind: tok.includes('/') ? 'remote' : 'head' });
    }
  }
  // 排序：HEAD 分支 → 本地 → 远程 → 标签
  const order = (c: RefChip): number => (c.isHead ? 0 : c.kind === 'head' ? 1 : c.kind === 'remote' ? 2 : 3);
  return chips.sort((a, b) => order(a) - order(b));
}

export interface RawRef {
  prefix: 'refs/heads/' | 'refs/remotes/' | 'refs/tags/';
  fullName: string;
  sha: string;             // annotated tag 已 peel 到 commit
  short: string;
  upstream?: string;
  trackAhead?: number;
  trackBehind?: number;
  subject?: string;
  date?: string;
  author?: string;
}

/** for-each-ref --format 以 %x00 分隔的 9 字段 */
export const EACH_REF_FORMAT =
  '%(refname)%00%(objectname)%00%(*objectname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(subject)%00%(authordate:iso-strict)%00%(authorname)';

export function parseForEachRef(out: string): RawRef[] {
  const refs: RawRef[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\x00');
    if (f.length < 9 || !f[0]) continue;
    const prefix = f[0].startsWith('refs/heads/') ? 'refs/heads/'
      : f[0].startsWith('refs/remotes/') ? 'refs/remotes/'
        : f[0].startsWith('refs/tags/') ? 'refs/tags/' : undefined;
    if (!prefix) continue;
    const { ahead, behind } = parseTrack(f[5]);
    refs.push({
      prefix: prefix as RawRef['prefix'],
      fullName: f[0],
      sha: f[2] || f[1],
      short: f[3],
      upstream: f[4] || undefined,
      trackAhead: ahead,
      trackBehind: behind,
      subject: f[6],
      date: f[7],
      author: f[8],
    });
  }
  return refs;
}

/** "ahead 1, behind 2" → {ahead, behind} */
export function parseTrack(s: string): { ahead?: number; behind?: number } {
  const ahead = /ahead (\d+)/.exec(s);
  const behind = /behind (\d+)/.exec(s);
  return {
    ahead: ahead ? Number(ahead[1]) : undefined,
    behind: behind ? Number(behind[1]) : undefined,
  };
}

export interface StatusInfo {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached: boolean;
  noCommitsYet: boolean;
  dirtyCount: number;
}

/**
 * git status --porcelain=v1 -z（NUL 分隔）→ 逐文件 FileEntry 矩阵 + 冲突标记。
 * 条目格式："XY␠path\0"；重命名/复制为 "XY␠new\0old\0"（紧随其后一个 NUL 记录原路径）。
 * 未跟踪 "??␠path"；忽略 "!..." 跳过；冲突字母（U 等）不在 M/A/D/R/C 白名单时归并为 M。
 */
export function parseStatusEntries(out: string): { entries: FileEntry[]; merging: boolean } {
  return parseEntryTokens(out.split('\0'), 0);
}

/**
 * status --porcelain=v1 -z -b 一次性解析（v0.7.2 性能优化：替代 -b 与 -z 各跑一次）：
 * 首个 NUL 记录为 "## ..." 分支头（喂 parseStatus），其后为文件条目。
 */
export function parseStatusZ(out: string): { info: StatusInfo; entries: FileEntry[]; merging: boolean } {
  const toks = out.split('\0');
  let info: StatusInfo = { detached: false, noCommitsYet: false, dirtyCount: 0 };
  let start = 0;
  if ((toks[0] ?? '').startsWith('## ')) {
    info = parseStatus(toks[0]);
    start = 1;
  }
  const { entries, merging } = parseEntryTokens(toks, start);
  info.dirtyCount = entries.length;   // -z 条目数即脏文件数（header 单独解析时计不到）
  return { info, entries, merging };
}

const STATUS_CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parseEntryTokens(toks: string[], start: number): { entries: FileEntry[]; merging: boolean } {
  const entries: FileEntry[] = [];
  let merging = false;
  for (let i = start; i < toks.length; i++) {
    const rec = toks[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    if (x === '!') continue;
    if (STATUS_CONFLICTS.has(x + y)) merging = true;
    if (x === '?') {
      entries.push({ path: rec.slice(3), staged: null, unstaged: null, untracked: true });
      continue;
    }
    const path = rec.slice(3);
    let origPath: string | undefined;
    if (x === 'R' || x === 'C') {
      const orig = toks[++i];
      if (orig) origPath = orig;
    }
    if (STATUS_CONFLICTS.has(x + y)) {
      // 冲突条目不入暂存/未暂存矩阵：单独分组；保留 XY 原码（UU/AA=双方都有内容；DU/UD=一方删除；AU/UA=一方新增）
      entries.push({ path, origPath, staged: null, unstaged: null, untracked: false, conflict: true, conflictCode: x + y });
      continue;
    }
    const staged = x !== ' ' && x !== '.' ? ('MADRC'.includes(x) ? (x as FileEntry['staged']) : 'M') : null;
    const unstaged = y !== ' ' && y !== '.' ? (y === 'D' ? 'D' : 'M') : null;
    entries.push({ path, origPath, staged, unstaged, untracked: false });
  }
  return { entries, merging };
}

/** git status --porcelain=v1 -b 首行 + 脏文件计数 */
export function parseStatus(out: string): StatusInfo {
  const lines = out.split('\n');
  const info: StatusInfo = { detached: false, noCommitsYet: false, dirtyCount: 0 };
  const head = lines[0] ?? '';
  if (head.startsWith('## ')) {
    const rest = head.slice(3);
    if (rest.startsWith('No commits yet on ')) {
      info.noCommitsYet = true;
      info.branch = rest.slice('No commits yet on '.length).split('...')[0];
    } else if (rest.startsWith('HEAD (no branch)')) {
      info.detached = true;
    } else {
      const m = /^([^.\s]+(?:[^\s.]|\.(?!\.))*)\.\.\.(\S+)(?: \[(.+)\])?/.exec(rest);
      if (m) {
        info.branch = m[1];
        info.upstream = m[2];
        const t = parseTrack(m[3] ?? '');
        info.ahead = t.ahead;
        info.behind = t.behind;
      } else {
        info.branch = rest.trim();
      }
    }
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim()) info.dirtyCount++;
  }
  return info;
}

/** diff-tree --name-status 与 --numstat 输出按行 zip */
export function parseFiles(nameStatus: string, numstat: string): FileChange[] {
  const ns = nameStatus.split('\n').filter(Boolean);
  const num = numstat.split('\n').filter(Boolean);
  const files: FileChange[] = [];
  for (let i = 0; i < ns.length; i++) {
    const parts = ns[i].split('\t');
    const statusLetter = parts[0][0] as FileStatus;
    if (!'AMDRCT'.includes(statusLetter)) continue;
    const n = num[i] ? num[i].split('\t') : undefined;
    const binary = !n || n[0] === '-' || n[1] === '-';
    files.push({
      status: statusLetter,
      path: statusLetter === 'R' || statusLetter === 'C' ? (parts[2] ?? parts[1]) : parts[1],
      oldPath: statusLetter === 'R' || statusLetter === 'C' ? parts[1] : undefined,
      additions: binary ? undefined : Number(n?.[0] ?? 0),
      deletions: binary ? undefined : Number(n?.[1] ?? 0),
    });
  }
  return files;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/;

/** 统计 diff 正文行数（首个 @@ 之后），用于超限判定 */
export function countDiffLines(text: string): number {
  let seenHunk = false;
  let count = 0;
  for (const line of text.split('\n')) {
    if (!seenHunk) { if (HUNK_RE.test(line)) seenHunk = true; continue; }
    count++;
  }
  return count;
}

export function parseUnifiedDiff(text: string): UnifiedDiff {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = { header: line, oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(cur);
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      continue;
    }
    if (!cur) continue;
    const dl: DiffLine = { kind: 'ctx', text: line.slice(1) };
    if (line.startsWith('+')) { dl.kind = 'add'; dl.newNo = newNo++; }
    else if (line.startsWith('-')) { dl.kind = 'del'; dl.oldNo = oldNo++; }
    else if (line.startsWith('\\')) { continue; }
    else { dl.oldNo = oldNo++; dl.newNo = newNo++; }
    dl.text = line.slice(1);
    cur.lines.push(dl);
  }
  return { hunks, truncated: false };
}

/** RawRef → 侧栏数据结构 */
export function buildRefTree(refs: RawRef[], headBranch?: string): { branches: BranchInfo[]; remotes: RemoteGroup[]; tags: TagInfo[] } {
  const branches: BranchInfo[] = [];
  const remotes = new Map<string, BranchInfo[]>();
  const tags: TagInfo[] = [];
  for (const r of refs) {
    if (r.prefix === 'refs/heads/') {
      branches.push({
        name: r.short, fullName: r.fullName, sha: r.sha,
        upstream: r.upstream, ahead: r.trackAhead, behind: r.trackBehind,
        isHead: r.short === headBranch, subject: r.subject, lastDate: r.date, author: r.author,
      });
    } else if (r.prefix === 'refs/remotes/') {
      if (r.short.endsWith('/HEAD')) continue;   // origin/HEAD 符号引用不展示
      const slash = r.short.indexOf('/');
      const remote = slash === -1 ? r.short : r.short.slice(0, slash);
      const list = remotes.get(remote) ?? [];
      list.push({
        name: r.short, fullName: r.fullName, sha: r.sha,
        isHead: false, subject: r.subject, lastDate: r.date, author: r.author,
      });
      remotes.set(remote, list);
    } else {
      tags.push({ name: r.short, sha: r.sha, date: r.date });
    }
  }
  const cmp = (a: BranchInfo, b: BranchInfo) => (Number(b.isHead) - Number(a.isHead)) || a.name.localeCompare(b.name);
  branches.sort(cmp);
  return {
    branches,
    remotes: [...remotes.entries()].map(([name, list]) => ({ name, branches: list.sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.name.localeCompare(b.name)),
    tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------- 文件历史页（v0.14） ----------

/** 文件历史格式：sha/短sha/作者/日期/主题 5 字段；记录后随 --follow --name-status 状态行 */
export const FILE_LOG_FORMAT = `%H${FS}%h${FS}%an${FS}%ad${FS}%s${RS}`;

const FILE_HEAD_RE = /^([0-9a-f]{40})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f(.*)\x1e$/;

/**
 * 解析 `log --follow --name-status --pretty=format:FILE_LOG_FORMAT -- path` 输出（逐行状态机，
 * 模式同 parseSummaryLog）：每条提交自带"当时路径"——M/A 行取该路径、R100 行取双端路径，
 * 跨移动/重命名的完整历史一次往返拿全（实测见方案 §3.3-A）。
 */
export function parseFileLog(out: string): FileHistoryItem[] {
  const items: FileHistoryItem[] = [];
  let cur: FileHistoryItem | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = line.match(FILE_HEAD_RE);
    if (m) {
      cur = { sha: m[1], shortSha: m[2], author: m[3], date: m[4], subject: m[5], path: '', status: 'M' };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const st = parts[0][0];
    if (st === 'R' || st === 'C') {
      cur.status = 'R';
      cur.oldPath = unescapeGitPath(parts[1]);
      cur.path = unescapeGitPath(parts[2] ?? parts[1]);
      cur.milestone = true;
    } else if (st === 'A') {
      cur.status = 'A';
      cur.path = unescapeGitPath(parts[1]);
    } else if (st === 'M' || st === 'T') {
      cur.status = 'M';
      cur.path = unescapeGitPath(parts[1]);
    }
  }
  return items;
}

/** 就地标注 eraPrefix（git follow 已给出每条提交的当时路径：与当前路径不同即历史时期）；返回移动/重命名次数 */
export function assignFileEras(items: FileHistoryItem[], currentPath: string): number {
  let changes = 0;
  for (const it of items) {
    it.eraPrefix = it.path === currentPath ? undefined : it.path;
    if (it.status === 'R') changes++;
  }
  return changes;
}

/** 由 R 行序列构建路径链（segments 新→旧；endSha = 移出该段的移动提交） */
export function chainFromFileLog(items: FileHistoryItem[], currentPath: string): PathChain {
  const segments: PathChain['segments'] = [{ prefix: currentPath }];
  for (const it of items) {   // items 为 log 输出序（新→旧）
    if (it.status === 'R' && it.oldPath) {
      segments[segments.length - 1].endSha = it.sha;
      segments.push({ prefix: it.oldPath });
    }
  }
  return { segments };
}

/** 目录链反查的旧前缀投票：新前缀 P 下 R 条目的旧路径，按祖先前缀从深到浅找覆盖率达标的最长候选 */
export function dirOldPrefix(
  renames: { oldPath: string; newPath: string }[],
  newPrefix: string,
  minRatio = 0.8,
): { prefix: string | null; ratio: number; partial: boolean } {
  const olds = renames.filter(r => r.newPath === newPrefix || r.newPath.startsWith(newPrefix + '/')).map(r => r.oldPath);
  if (!olds.length) return { prefix: null, ratio: 0, partial: false };
  const cands: string[] = [];
  let p = parentDir(olds[0]);
  cands.push(p);
  while (p.includes('/')) { p = parentDir(p); cands.push(p); }
  cands.push('');   // 仓库根
  for (const cand of cands) {
    const hit = olds.filter(o => o === cand || o.startsWith(cand ? cand + '/' : '/')).length;
    const ratio = hit / olds.length;
    if (ratio >= minRatio) return { prefix: cand, ratio, partial: ratio < 0.95 };
  }
  return { prefix: null, ratio: 0, partial: true };
}

export function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * 手动移动检测（R7）：未暂存"同前缀批量删除 + 同名未跟踪"配对。
 * 按父目录分组后找 basename 集合重合度最高的一对（≥1 即触发；已暂存的 R 状态 git 已识别，不在此列）。
 */
export function detectMove(entries: FileEntry[]): { from: string; to: string; count: number; paths: string[] } | undefined {
  const dels = new Map<string, Set<string>>();     // 父目录 → basename 集（unstaged D，非 untracked）
  const unts = new Map<string, Set<string>>();
  const delPaths = new Map<string, string>();       // basename@dir → 完整路径
  const untPaths = new Map<string, string>();
  for (const e of entries) {
    if (e.untracked) {
      const d = parentDir(e.path);
      const n = e.path.slice(e.path.lastIndexOf('/') + 1);
      if (!unts.has(d)) unts.set(d, new Set());
      unts.get(d)!.add(n);
      untPaths.set(d + '/' + n, e.path);
    } else if (e.unstaged === 'D') {
      const p = e.origPath ?? e.path;
      const d = parentDir(p);
      const n = p.slice(p.lastIndexOf('/') + 1);
      if (!dels.has(d)) dels.set(d, new Set());
      dels.get(d)!.add(n);
      delPaths.set(d + '/' + n, p);
    }
  }
  let best: { from: string; to: string; count: number; paths: string[] } | undefined;
  for (const [from, names] of dels) {
    for (const [to, unames] of unts) {
      if (from === to) continue;
      let hit = 0;
      for (const n of names) if (unames.has(n)) hit++;
      if (!hit) continue;
      if (best && hit <= best.count) continue;
      const paths: string[] = [];
      for (const n of names) {
        const dp = delPaths.get(from + '/' + n);
        if (dp) paths.push(dp);
      }
      for (const n of unames) {
        const up = untPaths.get(to + '/' + n);
        if (up) paths.push(up);
      }
      best = { from, to, count: hit, paths };
    }
  }
  return best;
}

/**
 * 语义侧（UI 的"我的/他人的"）→ git 级 ours 布尔（resolveConflict 的 --ours/--theirs 用）。
 * merge：我=stage2=--ours；rebase：我=stage3=--theirs（git 视角 ours 是重放基，与语义反转，设计方案 §4.6）。
 */
export function semanticToOurs(kind: 'merge' | 'rebase' | 'other', sideTheirs: boolean): boolean {
  return kind === 'rebase' ? sideTheirs : !sideTheirs;
}

/**
 * 合并会话分类（Issue #7 抽取自 panel.mergeSessionOf，纯函数可单测）：
 * 二进制（NUL 检测）/ 超限（16000 行 / 2MB，决议 #5）/ 删除侧（XY 码 + rebase 反转）。
 * 注意 tooLarge 优先于 binary 判定（超限二进制按超限会话处理，与既有行为一致）。
 */
export interface MergeSessionClass {
  binary: boolean;
  tooLarge: boolean;
  /** 双侧行数/字节的较大值（超限会话展示用） */
  lines: number;
  bytes: number;
  /** 语义侧（mine/theirs）在该冲突中是否不存在 */
  mineGone: boolean;
  theirsGone: boolean;
  /** 文本会话删除侧：DD（双删）= undefined（只剩采纳删除）；无删除 = undefined */
  deletedSideText: 'mine' | 'theirs' | undefined;
  /** 二进制会话删除侧：DD 按 'theirs'（panel 既有行为） */
  deletedSideBinary: 'mine' | 'theirs' | undefined;
}

export function classifyMergeSession(
  kind: 'merge' | 'rebase' | 'other',
  code: string,
  mine: string,
  theirs: string,
): MergeSessionClass {
  const usDeleted = code === 'DU' || code === 'DD';
  const themDeleted = code === 'UD' || code === 'DD';
  const rebase = kind === 'rebase';
  const mineGone = code === 'DD' ? true : (rebase ? themDeleted : usDeleted);
  const theirsGone = code === 'DD' ? true : (rebase ? usDeleted : themDeleted);
  const mineBytes = Buffer.byteLength(mine, 'utf8');
  const theirsBytes = Buffer.byteLength(theirs, 'utf8');
  const mineLines = mine ? mine.split('\n').length : 0;
  const theirsLines = theirs ? theirs.split('\n').length : 0;
  const lines = Math.max(mineLines, theirsLines);
  const bytes = Math.max(mineBytes, theirsBytes);
  const tooLarge = bytes > MERGE_MAX_BYTES || lines > MERGE_MAX_LINES;
  // 二进制：现存侧内容含 NUL → 只二选一 + 系统预览（gone 侧无内容不参与判定）
  const NUL = String.fromCharCode(0);
  const binary = (!mineGone && mine.includes(NUL)) || (!theirsGone && theirs.includes(NUL));
  return {
    binary, tooLarge, lines, bytes, mineGone, theirsGone,
    deletedSideText: code === 'DD' ? undefined : (mineGone ? 'mine' : theirsGone ? 'theirs' : undefined),
    deletedSideBinary: code === 'DD' ? 'theirs' : (mineGone ? 'mine' : theirsGone ? 'theirs' : undefined),
  };
}
