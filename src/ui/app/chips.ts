/**
 * 提交行 ref 徽标模型（Issue #24 抽纯函数可单测）：
 * 本地分支 ⑂ / 远程分支 ⇅ 字符前缀（非色觉依赖）；HEAD 徽标恒醒目（current 描边）；
 * 远程分支存在同名本地分支时降淡（本地徽标已表达该分支，远程只是影子指针）；
 * 标签照常显示在提交说明部分（决议 D4：标签不作图形起点，但徽标展示不变）。
 */
import type { Commit } from '../../common/models';

export interface ChipModel {
  cls: string;
  text: string;
  /** 悬停提示（#45）：徽标被截断或单元格剪裁时全名仍可达；+N 徽标为剩余标签名清单 */
  title?: string;
}

/** 远程名（origin/feature/x）剥离首段 remote 后是否命中本地分支名集合 */
export function remoteHasLocal(name: string, localNames: Set<string> | undefined): boolean {
  if (!localNames) return false;
  const i = name.indexOf('/');
  return i > 0 && localNames.has(name.slice(i + 1));
}

export function chipModels(
  c: Commit,
  opts: { showRemoteChips: boolean; maxTagChips: number; localNames?: Set<string> },
): ChipModel[] {
  const out: ChipModel[] = [];
  const tagNames: string[] = [];
  for (const ref of c.refs) if (ref.kind === 'tag') tagNames.push(ref.name);
  let shownTags = 0;
  for (const ref of c.refs) {
    if (ref.kind === 'remote' && !opts.showRemoteChips) continue;
    if (ref.kind === 'tag') {
      shownTags++;
      if (shownTags > opts.maxTagChips) continue;
    }
    let cls = `gg-chip ${ref.kind}`;
    let text: string;
    if (ref.kind === 'head') {
      if (ref.isHead) {
        cls += ' current';
        text = ref.name === 'HEAD' ? 'HEAD' : `HEAD → ${ref.name}`;
      } else {
        text = `⑂ ${ref.name}`;
      }
    } else if (ref.kind === 'remote') {
      if (remoteHasLocal(ref.name, opts.localNames)) cls += ' dim';
      text = `⇅ ${ref.name}`;
    } else {
      text = ref.name;
    }
    out.push({ cls, text, title: ref.name });
  }
  if (tagNames.length > opts.maxTagChips) {
    // 剩余标签名进悬停提示（#45）：+N 不再只是数字
    const rest = tagNames.slice(opts.maxTagChips).join('\n');
    out.push({ cls: 'gg-chip tag more', text: `+${tagNames.length - opts.maxTagChips}`, title: rest });
  }
  return out;
}
