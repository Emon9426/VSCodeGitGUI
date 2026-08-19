/** 右键菜单、对话框、toast（浮层，挂在 document.body）。 */
import { S } from '../state';
import { el, clearChildren } from '../util';

export interface MenuItem {
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  run?: () => void;
}

let menuEl: HTMLElement | undefined;

export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  closeContextMenu();
  const menu = el('div', 'gg-menu');
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'gg-menu-sep')); continue; }
    const item = el('div', `gg-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`, it.label);
    if (!it.disabled && it.run) {
      item.addEventListener('click', () => { closeContextMenu(); it.run!(); });
    }
    menu.appendChild(item);
  }
  menu.addEventListener('contextmenu', e => e.preventDefault());
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
  menuEl = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, { capture: true });
    document.addEventListener('keydown', onEsc, { capture: true });
  });
}

function onDocMouseDown(e: MouseEvent): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
}
function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeContextMenu();
}

export function closeContextMenu(): void {
  menuEl?.remove();
  menuEl = undefined;
  document.removeEventListener('mousedown', onDocMouseDown, { capture: true });
  document.removeEventListener('keydown', onEsc, { capture: true });
}

// ---------------- 对话框 ----------------

function openModal(title: string): { box: HTMLElement; body: HTMLElement; close: () => void } {
  const overlay = el('div', 'gg-modal-overlay');
  const box = el('div', 'gg-modal');
  const head = el('div', 'gg-modal-title', title);
  const body = el('div', 'gg-modal-body');
  box.append(head, body);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return { box, body, close: () => overlay.remove() };
}

export function confirmDialog(
  title: string, message: string, okLabel: string, danger = false,
): Promise<boolean> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(title);
    body.appendChild(el('div', 'gg-modal-text', message));
    const btns = el('div', 'gg-modal-btns');
    const cancel = el('button', 'gg-btn', S.t('cancel'));
    const ok = el('button', danger ? 'gg-btn danger' : 'gg-btn primary', okLabel);
    cancel.addEventListener('click', () => { close(); resolve(false); });
    ok.addEventListener('click', () => { close(); resolve(true); });
    btns.append(cancel, ok);
    box.appendChild(btns);
    ok.focus();
  });
}

export function promptDialog(title: string, label: string, value: string): Promise<string | null> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(title);
    const lab = el('label', 'gg-modal-label', label);
    const input = el('input', 'gg-input') as HTMLInputElement;
    input.value = value;
    lab.appendChild(input);
    body.appendChild(lab);
    const btns = el('div', 'gg-modal-btns');
    const cancel = el('button', 'gg-btn', S.t('cancel'));
    const ok = el('button', 'gg-btn primary', S.t('ok'));
    const done = (v: string | null) => { close(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value.trim() || null); });
    btns.append(cancel, ok);
    box.appendChild(btns);
    input.focus();
    input.select();
  });
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

/** reset 模式选择（设计方案 6.5：hard 需强确认） */
export function resetDialog(sha: string, dirtyCount: number, t: (k: string, p?: Record<string, string | number>) => string): Promise<ResetMode | null> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(t('resetTitle', { sha: sha.slice(0, 7) }));
    const modes: ResetMode[] = ['soft', 'mixed', 'hard'];
    let selected: ResetMode = 'mixed';
    const warn = el('div', 'gg-modal-warn');
    const renderWarn = () => {
      clearChildren(warn);
      warn.className = 'gg-modal-warn' + (selected === 'hard' ? ' show' : '');
      if (selected === 'hard' && dirtyCount > 0) {
        warn.textContent = t('hardWarning', { n: dirtyCount });
      }
    };
    for (const mode of modes) {
      const id = `gg-reset-${mode}`;
      const row = el('label', 'gg-radio-row');
      const input = el('input') as HTMLInputElement;
      input.type = 'radio';
      input.name = 'gg-reset-mode';
      input.id = id;
      input.checked = mode === 'mixed';
      const text = el('span', undefined, t(`mode${mode[0].toUpperCase()}${mode.slice(1)}`));
      row.append(input, text);
      input.addEventListener('change', () => {
        selected = mode;
        ok.textContent = mode === 'hard' ? t('hardConfirm') : t('confirm');
        ok.className = mode === 'hard' ? 'gg-btn danger' : 'gg-btn primary';
        renderWarn();
      });
      body.appendChild(row);
    }
    renderWarn();
    body.appendChild(warn);
    const btns = el('div', 'gg-modal-btns');
    const cancel = el('button', 'gg-btn', S.t('cancel'));
    const ok = el('button', 'gg-btn primary', t('confirm'));
    cancel.addEventListener('click', () => { close(); resolve(null); });
    ok.addEventListener('click', () => { close(); resolve(selected); });
    btns.append(cancel, ok);
    box.appendChild(btns);
  });
}

// ---------------- Toast ----------------

export function toast(level: 'info' | 'warn' | 'error', message: string, action?: { label: string; run: () => void }): void {
  const host = document.querySelector('.gg-toasts') ?? (() => {
    const h = el('div', 'gg-toasts');
    document.body.appendChild(h);
    return h;
  })();
  const item = el('div', `gg-toast ${level}`);
  item.appendChild(el('span', 'gg-toast-text', message));
  if (action) {
    const btn = el('button', 'gg-toast-btn', action.label);
    btn.addEventListener('click', () => { action.run(); item.remove(); });
    item.appendChild(btn);
  }
  const closeBtn = el('button', 'gg-toast-x', '×');
  closeBtn.addEventListener('click', () => item.remove());
  item.appendChild(closeBtn);
  host.appendChild(item);
  setTimeout(() => item.classList.add('fade'));
  setTimeout(() => item.remove(), 8000);
}
