/**
 * 快速笔记 webview 内轻量对话框（v0.15.0）：右键菜单 / 输入 / 确认。
 * 不复用主面板 overlays（其依赖主面板 state），保持 notes bundle 独立。
 */
import { el } from '../util';

export interface MenuItem { label: string; danger?: boolean; run(): void }

let openLayers: HTMLElement[] = [];

type Layer = HTMLElement & { close(): void };

function layer(inner: HTMLElement, centered = false): Layer {
  const box = el('div', 'gg-dialog-layer') as unknown as Layer;
  if (centered) {
    // v0.17 修复：fixed 定位若无 left/top 会落到文档流静态位置（#notes-app 100% 高之后）→ 视口外不可见，
    // 导致"删除笔记/重命名"点击后看似无反应。对话框一律居中呈现。
    box.style.left = '50%';
    box.style.top = '50%';
    box.style.transform = 'translate(-50%, -50%)';
  }
  box.appendChild(inner);
  document.body.appendChild(box);
  openLayers.push(box);
  box.close = (): void => {
    box.remove();
    openLayers = openLayers.filter(b => b !== box);
    document.removeEventListener('pointerdown', onDoc, true);
  };
  const onDoc = (e: PointerEvent): void => {
    if (!box.contains(e.target as Node)) box.close();
  };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  return box;
}

/** 右键/下拉菜单 */
export function showMenu(items: MenuItem[], x: number, y: number): void {
  const menu = el('div', 'gg-menu');
  for (const it of items) {
    const row = el('div', `gg-menu-item${it.danger ? ' danger' : ''}`, it.label);
    row.addEventListener('click', () => { box.close(); it.run(); });
    menu.appendChild(row);
  }
  const box = layer(menu);
  const w = 190;
  box.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 8))}px`;
  box.style.top = `${Math.max(6, Math.min(y, window.innerHeight - items.length * 28 - 16))}px`;
}

/** 单行输入对话框；取消返回 null */
export function showPrompt(title: string, label: string, value: string): Promise<string | null> {
  return new Promise(resolve => {
    const card = el('div', 'gg-prompt');
    card.appendChild(el('div', 'gg-prompt-title', title));
    const input = el('input', 'gg-prompt-input') as HTMLInputElement;
    input.value = value;
    card.appendChild(input);
    const row = el('div', 'gg-prompt-acts');
    const done = (v: string | null): void => { box.close(); resolve(v); };
    const ok = el('button', 'gg-btn primary', '✓');
    ok.addEventListener('click', () => done(input.value.trim() || null));
    const cancel = el('button', 'gg-btn', '✕');
    cancel.addEventListener('click', () => done(null));
    row.append(cancel, ok);
    card.appendChild(row);
    const box = layer(card, true);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** 确认对话框 */
export function showConfirm(title: string, message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise(resolve => {
    const card = el('div', 'gg-prompt');
    card.appendChild(el('div', 'gg-prompt-title', title));
    card.appendChild(el('div', 'gg-prompt-msg', message));
    const row = el('div', 'gg-prompt-acts');
    const done = (v: boolean): void => { box.close(); resolve(v); };
    const ok = el('button', `gg-btn primary${danger ? ' danger' : ''}`, okLabel);
    ok.addEventListener('click', () => done(true));
    const cancel = el('button', 'gg-btn', '✕');
    cancel.addEventListener('click', () => done(false));
    row.append(cancel, ok);
    card.appendChild(row);
    const box = layer(card, true);
  });
}
