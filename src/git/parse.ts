/**
 * git 输出解析器（纯函数，设计方案 13.1 单测对象）。
 */
import type { Commit, RefChip, BranchInfo, TagInfo, RemoteGroup, FileChange, FileStatus, UnifiedDiff, DiffHunk, DiffLine, FileEntry } from '../common/models';

export const FS = '\x1f';   // 字段分隔符
export const RS = '\x1e';   // 记录分隔符

/** %H %h %P an ae ad cn ce cd D s b —— 13 字段 */
export const LOG_FORMAT =
  `%H${FS}%h${FS}%P${FS}%an${FS}%ae${FS}%ad${FS}%cn${FS}%ce${FS}%cd${FS}%D${FS}%s${FS}%b${RS}`;

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
      // 冲突条目不入暂存/未暂存矩阵：单独分组，由 ours/theirs 二选一解决
      entries.push({ path, origPath, staged: null, unstaged: null, untracked: false, conflict: true });
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
