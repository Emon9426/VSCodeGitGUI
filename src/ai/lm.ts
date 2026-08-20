/**
 * vscode.lm（Language Model API）最小类型垫片 + 特性探测。
 *
 * GitBoard 保持 engines ^1.85，而 vscode.lm 稳定于 VS Code 1.99：
 * 运行时以鸭子类型探测（存在即用、缺失即隐藏 AI 入口），不提升 engines
 * ——老版本用户其余功能不受影响（设计方案 §7.2 兜底路线）。
 *
 * 账户/配额：LM API 由 VS Code 内置 Copilot 服务提供，复用当前登录的
 * GitHub 账号（与 Copilot Chat 同一订阅与配额池），扩展零凭证（§5.1）。
 */
import type * as vscode from 'vscode';

export interface LmChatModelLike {
  id: string;
  name: string;
  vendor: string;
  family: string;
  isDefault?: boolean;
  sendRequest(
    messages: unknown[],
    options: unknown,
    token: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): void },
  ): Promise<{ text: AsyncIterable<string> }>;
}

export interface LmNamespaceLike {
  selectChatModels(selector?: { vendor?: string; family?: string; id?: string }): PromiseLike<LmChatModelLike[]>;
}

/** 探测宿主是否提供 vscode.lm（不存在返回 undefined，调用方隐藏 AI 能力） */
export function lmApi(vsc: typeof vscode): LmNamespaceLike | undefined {
  const ns = (vsc as unknown as { lm?: LmNamespaceLike }).lm;
  return ns && typeof ns.selectChatModels === 'function' ? ns : undefined;
}

/** 构造 user 消息（优先官方静态构造器，老形态回退裸对象） */
export function userMessage(vsc: typeof vscode, text: string): unknown {
  const ctor = (vsc as unknown as { LanguageModelChatMessage?: { User?: (t: string) => unknown } }).LanguageModelChatMessage;
  if (ctor?.User) return ctor.User(text);
  return { role: 'user', content: text };
}

/** LM 错误分类（403 未登录/无权限、429 配额、取消，其余归 error） */
export function classifyLmError(e: unknown): 'auth' | 'quota' | 'canceled' | 'error' {
  const msg = String((e as Error)?.message ?? e);
  if (/cancel/i.test(msg)) return 'canceled';
  if (/\b403\b|unauthorized|not signed in|no entitlement|access denied/i.test(msg)) return 'auth';
  if (/\b429\b|too many requests|quota|rate limit/i.test(msg)) return 'quota';
  return 'error';
}
