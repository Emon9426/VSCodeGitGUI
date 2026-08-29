/**
 * Pull/Fetch 摘要查询（v0.13）：
 * 对比操作前后的 refs，列出拉到的纯净提交（--no-merges，排除 Branch/Merge 等操作提交），
 * 附每条提交的变更文件清单——说明"哪些人有哪些提交修改了哪些文件"。
 *
 * 安全形态：execFile + 全字面量参数数组（绝不经 shell）；仓库路径经 cwd 选项传入；
 * 动态引用（sha 列表）经 40 位 hex 白名单校验后从 stdin 递交给 git log --stdin，
 * 不进入命令参数——对参数注入天然免疫。
 */
import { execFile } from 'child_process';
import type { PullSummaryEntry } from '../common/models';
import type { GitExecutor } from './executor';
import { parseSummaryLog } from './parse';

/** 完整对象 sha 白名单：摘要引用值只接受 git 产出的 40 位 hex（防御 refs 漂移时的意外值） */
const SHA_RE = /^[0-9a-f]{40}$/i;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;

export class PullSummaryService {
  constructor(private readonly executor: GitExecutor) {}

  /**
   * include 可达、exclude 不可达的纯净提交（--no-merges），日期序、附变更文件。
   * 多取 1 条以判断是否截断。
   */
  async of(
    root: string,
    include: string[],
    exclude: string[],
    opts?: { maxCommits?: number; maxFiles?: number },
  ): Promise<{ entries: PullSummaryEntry[]; truncated: boolean }> {
    const inc = include.filter(s => SHA_RE.test(s));
    if (!inc.length) return { entries: [], truncated: false };
    const exc = exclude.filter(s => SHA_RE.test(s));
    const cap = Math.min(Math.max(opts?.maxCommits ?? 100, 1), 500);
    const maxFiles = Math.min(Math.max(opts?.maxFiles ?? 50, 1), 500);
    // include 直接给出，exclude 以 ^ 前缀排除（--not 语义）；全部旧 refs 作排除集，跨 ref 去重
    const stdinText = [...inc, ...exc.map(s => '^' + s)].join('\n');
    const stdout = await this.runLog(root, stdinText, cap + 1);
    const entries = parseSummaryLog(stdout, maxFiles);
    let truncated = false;
    if (entries.length > cap) { entries.length = cap; truncated = true; }
    return { entries, truncated };
  }

  /** git log --stdin：sha 引用集经 stdin 递交（命令参数保持全字面量，cwd 定位仓库） */
  private runLog(root: string, stdinText: string, limit: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.executor.path, [
        // 与 executor 公共参数同款：中文路径不转八进制转义（\357\274\210 之类）
        '-c', 'core.quotepath=false',
        'log', '--no-merges', '--date-order', '--date=iso-strict',
        '--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1e', '--name-status', '-M',
        '-n', String(limit), '--stdin',
      ], { cwd: root, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES });
      let out = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      child.once('error', reject);
      child.once('close', () => resolve(out));
      child.stdin?.write(stdinText);
      child.stdin?.end();
    });
  }
}
