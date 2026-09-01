#!/usr/bin/env bash
# GitBoard Issue 修复工作流（规范见 docs/issue-workflow.md）
#
#   start  <N> [slug]            为 Issue N 创建分支（gh issue develop + 关联分支）并切换
#   commit <msg> [N ...]         提交暂存区，footer 自动附加 Refs #N（N 缺省取分支主 Issue）
#   pr     [title] [选项]        typecheck+test 全绿后建 PR，自动汇总 Refs → Closes
#                                 选项: --dry-run 仅打印、--skip-test 跳过测试门槛
#   merge                        squash 合并当前分支的 PR、删分支、切回 main 并拉取
set -euo pipefail

BASE="main"
if command -v gh >/dev/null 2>&1; then GH="gh"; else GH="C:/Users/Emon/.zcode/tools/gh/bin/gh.exe"; fi

die() { echo "错误: $*" >&2; exit 1; }
trap 'echo "issue-flow: 命令失败于第 $LINENO 行" >&2' ERR
usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

slugify() {  # 从文本提取小写 ASCII 词，最多 4 个，用 - 连接；无则输出空
  # 注意：不能在管道中用 head 截断（pipefail 下 SIGPIPE 会静默杀死脚本），先落变量
  local words
  words=$(tr '[:upper:]' '[:lower:]' <<<"$1" | grep -oE '[a-z0-9]+' || true)
  [ -n "$words" ] && echo "$words" | head -n 4 | paste -sd - -
  return 0
}

current_issue() {  # 从当前分支名解析主 Issue 号（无匹配返回空，不触发 set -e）
  git branch --show-current | grep -oE '^issues?-[0-9]+' | grep -oE '[0-9]+' | head -1 || true
}

remote_branch_alive() {  # 校验远端分支真实存在：本地 remote-tracking ref 可能是已删分支的残影
  "$GH" api "repos/:owner/:repo/git/refs/heads/$1" >/dev/null 2>&1
}

cmd_start() {
  local n="${1:?用法: start <N> [slug]}" slug="${2:-}" branch existing
  if git show-ref --verify --quiet "refs/heads/issue-${n}"; then
    branch="issue-${n}"
  elif [ -n "$slug" ]; then
    branch="issue-${n}-${slug}"
  else
    # 未给 slug：若远端恰好只有一个 issue-N-* 分支，直接复用，避免重复建分支
    # 注意：for-each-ref 不带通配符的模式只匹配完整 ref 或斜杠边界前缀，必须带 *
    existing=$(git for-each-ref --format='%(refname:short)' "refs/remotes/origin/issue-${n}-*" | sed 's|^origin/||')
    if [ "$(grep -c . <<<"$existing" || true)" -eq 1 ]; then
      branch="$existing"
    else
      slug=$(slugify "$("$GH" issue view "$n" --json title --jq '.title' 2>/dev/null || true)")
      branch="issue-${n}${slug:+-$slug}"
    fi
  fi
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git switch "$branch" && echo "已切换到 $branch（复用本地分支）"
  elif git show-ref --verify --quiet "refs/remotes/origin/$branch" && remote_branch_alive "$branch"; then
    git switch "$branch" && echo "已切换到 $branch（复用远端分支）"
  else
    "$GH" issue develop "$n" --base "$BASE" --name "$branch"
    git switch "$branch" && echo "已切换到 $branch（Issue #$n 已挂关联分支）"
  fi
}

cmd_commit() {
  local msg="${1:?用法: commit <msg> [N ...]}"; shift || true
  local nums=("$@") footer="" n
  if [ ${#nums[@]} -eq 0 ]; then
    n=$(current_issue)
    [ -n "$n" ] || die "无法从分支名解析 Issue 号，请显式传入: commit \"<msg>\" <N>"
    nums=("$n")
  fi
  for n in "${nums[@]}"; do
    case "$n" in ''|*[!0-9]*) die "非法 Issue 号: $n";; esac
    footer+="Refs #${n}"$'\n'
  done
  git commit -m "$msg" -m "$(printf '%s' "$footer")"
}

cmd_pr() {
  local title="" dry=0 skip=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1 ;;
      --skip-test) skip=1 ;;
      -h|--help) usage ;;
      *) [ -n "$title" ] && die "标题只能有一个: $title / $1"; title="$1" ;;
    esac
    shift
  done
  local head; head=$(git branch --show-current)
  [ "$head" = "$BASE" ] && die "当前在 $BASE，请先切到 Issue 分支"
  local verify="- [ ] 未执行（--skip-test）"
  if [ "$skip" -eq 0 ]; then
    npm run typecheck && npm run test
    verify="- [x] npm run typecheck + npm run test"
  fi

  # 汇总分支上全部 commit 的 Refs #N（去重升序）；空匹配时 grep 退 1，须 || true 兜底走友好报错
  local nums; nums=$(git log "$BASE..HEAD" --format=%B | grep -oE 'Refs #[0-9]+' | grep -oE '[0-9]+' | sort -un || true)
  [ -n "$nums" ] || die "分支提交中没有找到 Refs #N，请用 commit 子命令提交"

  local body="" n t titles=""
  for n in $nums; do
    t=$("$GH" issue view "$n" --json title --jq '.title' 2>/dev/null || echo "")
    titles+="#$n "
    body+="Closes #${n}${t:+ $t}"$'\n'
  done
  [ -n "$title" ] || title="fix: ${titles% }"

  body="## 关联 Issue"$'\n'$'\n'"$body"$'\n'"## 验证"$'\n'$'\n'"$verify"$'\n'
  if [ "$dry" -eq 1 ]; then
    echo "== PR 标题 =="; echo "$title"; echo "== PR Body =="; echo "$body"; return
  fi
  "$GH" pr create --base "$BASE" --head "$head" --title "$title" --body "$body"
}

cmd_merge() {
  "$GH" pr merge --squash --delete-branch
  git switch "$BASE" && git pull --ff-only
}

case "${1:-}" in
  start)  shift; cmd_start "$@" ;;
  commit) shift; cmd_commit "$@" ;;
  pr)     shift; cmd_pr "$@" ;;
  merge)  cmd_merge ;;
  ""|-h|--help) usage ;;
  *) die "未知子命令: $1（见 -h）" ;;
esac
