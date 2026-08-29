/**
 * 文件历史页查询（v0.14）：目录浏览（HEAD 快照 + 工作区 stat）、文件/目录历史
 * （跨移动/重命名跟随：链反查 + 多 pathspec OR）、任意两版本 blob 级比对。
 *
 * 安全形态（与 summary.ts 同款）：execFile + 参数数组（绝不经 shell）；仓库路径经 cwd 传入；
 * 动态路径经 safeRelPath 白名单、sha 经 40 位 hex 白名单校验后作为独立参数元素
 * （authorsOf 的"白名单清洗后使用"模式）；格式串全部为模块内常量字面量。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DiffPayload, FileHistoryItem, FileItem, PathChain } from '../common/models';
import { GitError, type GitExecutor } from './executor';
import {
  FILE_LOG_FORMAT, LOG_FORMAT,
  assignFileEras, chainFromFileLog, countDiffLines, dirOldPrefix,
  parseFileLog, parseLog, parentDir, parseUnifiedDiff, unescapeGitPath,
} from './parse';

const TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
/** 仓库相对路径白名单：字母/数字（含中文）/常见文件名符号（# & % ^ = { } 等），正斜杠分隔，限长 500；
 * 拒绝 "-" / ":" 开头（防 git 选项与 pathspec magic 注入）与 ".." 段（防穿越）。
 * 含 * ? [ ] 等 glob 元字符不支持（pathspec 通配语义，属已知限制）。 */
const PATH_ARG_RE = /^[\p{L}\p{N} .@_+\-#'!()（）%&^={}!",;~\\/]+$/u;

export function isFullSha(s: string): boolean {
  return SHA_RE.test(s);
}

export function safeRelPath(s: string): string | null {
  const t = s.trim().replace(/\\/g, '/');
  if (!t || t.length > 500 || t.startsWith('-') || t.startsWith(':')) return null;
  if (t.split('/').includes('..')) return null;   // 路径穿越（仓库外）拒绝
  return PATH_ARG_RE.test(t) ? t : null;
}

/** HEAD 快照索引：按父目录分桶的文件清单 + 全目录集合（ls-tree 一次构建，按仓库缓存） */
interface TreeIndex {
  byDir: Map<string, { name: string; path: string; gitSize?: number }[]>;
  dirs: Set<string>;
}

const isNoCommitRepo = (e: unknown) =>
  typeof e === 'object' && e !== null && /does not have any commits yet|ambiguous argument|not a valid object name head/i.test(String((e as Error).message));

export class FilesService {
  constructor(private readonly executor: GitExecutor) {}
  private readonly treeIndex = new Map<string, TreeIndex>();

  /** HEAD 快照失效（提交/移动/删除等操作成功后由 panel 调用） */
  invalidateTree(root: string): void {
    this.treeIndex.delete(root);
  }

  /** 执行 git（cwd 定位仓库；中文路径不转八进制转义；失败抛 GitError） */
  private run(root: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.executor.path, ['-c', 'core.quotepath=false', ...args], {
        cwd: root, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BYTES,
      });
      let out = '';
      let errText = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      child.stderr?.on('data', (c: Buffer) => { errText += c.toString('utf8'); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) { resolve(out); return; }
        reject(new GitError('E_GIT_EXIT', `git exited ${code}: ${errText.split('\n').slice(0, 3).join(' ') || out.slice(0, 200)}`, code ?? undefined, args[0], errText.slice(-2000)));
      });
    });
  }

  private async treeIndexOf(root: string): Promise<TreeIndex> {
    const cached = this.treeIndex.get(root);
    if (cached) return cached;
    const out = await this.run(root, ['ls-tree', '-r', '-z', '-l', '--', 'HEAD']);
    const byDir: TreeIndex['byDir'] = new Map();
    const dirs = new Set<string>();
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(' ');
      if (meta[1] !== 'blob') continue;   // 跳过 gitlink（子模块）
      const p = unescapeGitPath(rec.slice(tab + 1));
      const i = p.lastIndexOf('/');
      const dir = i < 0 ? '' : p.slice(0, i);
      const size = Number(meta[3]);
      let arr = byDir.get(dir);
      if (!arr) { arr = []; byDir.set(dir, arr); }
      arr.push({ name: i < 0 ? p : p.slice(i + 1), path: p, gitSize: Number.isFinite(size) ? size : undefined });
      let d = dir;
      for (;;) {   // 所有祖先目录入集合
        dirs.add(d);
        if (!d) break;
        d = parentDir(d);
      }
    }
    const idx: TreeIndex = { byDir, dirs };
    this.treeIndex.set(root, idx);
    return idx;
  }

  /** 目录直接子项（HEAD 快照 + 工作区 stat 并行；目录项含直接子项计数）。
   *  kind：dir=目录（items 为子项）/ file=路径是文件（items 空，供地址栏定位）/ none=不存在 */
  async lsOf(root: string, dir: string): Promise<{ items: FileItem[]; kind: 'dir' | 'file' | 'none' }> {
    const raw = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');   // 尾斜杠归一（地址栏容错）
    const p = raw === '' ? '' : safeRelPath(raw);
    if (p === null) return { items: [], kind: 'none' };   // 白名单外字符 / 穿越路径：快速失败（先于仓库探测）
    let idx: TreeIndex;
    try {
      idx = await this.treeIndexOf(root);
    } catch (e) {
      if (isNoCommitRepo(e)) return { items: [], kind: 'dir' };
      throw e;
    }
    if (p !== raw) return { items: [], kind: 'none' };
    let kind: 'dir' | 'file' | 'none' = 'none';
    if (!p || idx.dirs.has(p)) kind = 'dir';
    else {
      outer: for (const arr of idx.byDir.values()) {
        for (const f of arr) {
          if (f.path === p) { kind = 'file'; break outer; }
        }
      }
    }
    if (kind !== 'dir') return { items: [], kind };
    const prefix = p ? p + '/' : '';
    const items: FileItem[] = [];
    for (const f of idx.byDir.get(p) ?? []) {
      items.push({ name: f.name, path: f.path, isDir: false, gitSize: f.gitSize });
    }
    const seen = new Set<string>();
    for (const d of idx.dirs) {
      if (d === p || !d.startsWith(prefix)) continue;
      const name = d.slice(prefix.length).split('/')[0];
      if (seen.has(name)) continue;
      seen.add(name);
      const full = prefix + name;
      // 直接子项数 = 直接文件数 + 直接子目录数
      const cnt = (idx.byDir.get(full)?.length ?? 0)
        + [...idx.dirs].filter(x => x.startsWith(full + '/') && parentDir(x) === full).length;
      items.push({ name, path: full, isDir: true, count: cnt });
    }
    items.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name, 'zh-CN'));
    // 工作区 stat（大小/修改日期）：仅对存在的直接子项并行采集
    await Promise.all(items.map(async it => {
      const abs = path.resolve(root, it.path);
      if (!(abs === root || abs.startsWith(root + path.sep))) return;   // 防御：越界路径跳过
      try {
        const st = await fs.promises.stat(abs);
        if (it.isDir) return;
        it.size = st.size;
        it.mtime = st.mtime.toISOString();
      } catch { /* 不在工作区（历史文件）→ 列显示 — */ }
    }));
    return { items, kind: 'dir' as const };
  }

  /** 文件历史：--follow --name-status 单命令（跨移动/重命名完整历史 + 每条提交的当时路径） */
  async fileLogOf(root: string, filePath: string): Promise<{ items: FileHistoryItem[]; chain: PathChain }> {
    const p = safeRelPath(filePath);
    if (!p) throw new Error('unsupported path');
    const args = [
      'log', '--follow', '--name-status', '-M', '--date=iso-strict',
      '--pretty=format:' + FILE_LOG_FORMAT, '--', p,
    ];
    const out = await this.run(root, args, LOG_TIMEOUT_MS);
    const items = parseFileLog(out);
    assignFileEras(items, p);
    const chain = chainFromFileLog(items, p);
    return { items, chain };
  }

  /** 最早涉及提交（边界提交）：目录链反查的锚点（输出为纯 sha 列表，白名单过滤） */
  private async boundaryOf(root: string, specs: string[]): Promise<string | null> {
    const args = ['log', '--format=%H', '--'];
    for (const s of specs) args.push(s);
    const out = await this.run(root, args, LOG_TIMEOUT_MS);
    const lines = out.split('\n').map(s => s.trim()).filter(isFullSha);
    return lines.length ? lines[lines.length - 1] : null;
  }

  /**
   * 目录历史：链反查（边界提交无 pathspec 全量 diff → 旧前缀投票，迭代 ≤ 8）
   * + 多 pathspec OR 合并查询；时期按链段 endSha 切分（移动提交 = 里程碑）。
   */
  async dirLogOf(root: string, dir: string, follow: boolean): Promise<{ items: FileHistoryItem[]; chain: PathChain }> {
    const raw = dir.trim().replace(/\\/g, '/');
    const dirPath = raw === '' ? '' : safeRelPath(raw);   // '' = 仓库根（合法）
    if (dirPath === null) throw new Error('unsupported path');
    const segments: PathChain['segments'] = [{ prefix: dirPath }];
    const specs: string[] = [dirPath];
    let partial = false;
    if (follow && dirPath) {
      let cur = dirPath;
      for (let round = 0; round < 8; round++) {
        let el: string | null = null;
        const renames: { oldPath: string; newPath: string }[] = [];
        try {
          el = await this.boundaryOf(root, specs);
          if (!el) break;
          const out = await this.run(root, ['-c', 'diff.renameLimit=10000', 'show', '-M', '--name-status', '--no-color', '--format=', el]);
          for (const line of out.split('\n')) {
            const parts = line.split('\t');
            if (parts.length >= 3 && (parts[0][0] === 'R' || parts[0][0] === 'C')) {
              renames.push({ oldPath: unescapeGitPath(parts[1]), newPath: unescapeGitPath(parts[2]) });
            }
          }
        } catch { break; }
        if (!renames.length) break;
        const vote = dirOldPrefix(renames, cur);
        if (vote.prefix === null || !safeRelPath(vote.prefix)) { partial = true; break; }
        segments[segments.length - 1].endSha = el!;
        segments.push({ prefix: vote.prefix });
        if (vote.partial) { partial = true; break; }
        specs.push(vote.prefix);
        cur = vote.prefix;
      }
    }
    const args = ['log', '--date=iso-strict', '--pretty=format:' + LOG_FORMAT, '--'];
    for (const s of specs) args.push(s);
    const out = await this.run(root, args, LOG_TIMEOUT_MS);
    const commits = parseLog(out, {});
    const items: FileHistoryItem[] = [];
    let segIdx = 0;
    for (const c of commits) {   // log 输出序（新→旧）：遇链段 endSha（移动提交，属本段）后更旧的归上一段
      const seg = segments[Math.min(segIdx, segments.length - 1)];
      const isMilestone = c.sha === seg.endSha;
      items.push({
        sha: c.sha, shortSha: c.shortSha, subject: c.subject, author: c.author.name, date: c.author.date,
        path: seg.prefix, status: 'M', eraPrefix: segIdx === 0 ? undefined : seg.prefix, milestone: isMilestone || undefined,
      });
      if (isMilestone) segIdx++;
    }
    return { items, chain: { segments, partial: partial || undefined } };
  }

  /** ls-files 判定跟踪状态（未跟踪项删除走磁盘而非 git rm；白名单外路径视为未跟踪） */
  async trackedOf(root: string, relPath: string): Promise<boolean> {
    const p = safeRelPath(relPath);
    if (!p) return false;
    const args = ['ls-files', '--error-unmatch', '--', p];
    try {
      await this.run(root, args, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  /** 两版比对（blob 级）：跨移动/重命名时期有效——各取当时路径，sha 定界（40hex 后首个 ":" 即分隔） */  async blobDiffOf(root: string, a: { sha: string; path: string }, b: { sha: string; path: string }): Promise<DiffPayload> {
    const pa = safeRelPath(a.path);
    const pb = safeRelPath(b.path);
    if (!isFullSha(a.sha) || !isFullSha(b.sha) || !pa || !pb) throw new Error('unsupported ref');
    const aRef = a.sha + ':' + pa;
    const bRef = b.sha + ':' + pb;
    const [numOut, diffOut] = await Promise.all([
      this.run(root, ['diff', '--numstat', '-M', aRef, bRef]),
      this.run(root, ['diff', '--unified=3', '--no-color', '-M', aRef, bRef]),
    ]);
    const first = numOut.split('\n').find(Boolean);
    if (first && first.split('\t')[0] === '-') return { kind: 'binary' };
    if (countDiffLines(diffOut) > 5000) return { kind: 'tooLarge' };
    const diff = parseUnifiedDiff(diffOut);
    if (diff.hunks.length === 0) return { kind: 'empty' };
    return { kind: 'diff', diff };
  }
}
