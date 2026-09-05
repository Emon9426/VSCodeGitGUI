/** 右键菜单、对话框、通知（浮层，挂在 document.body）。 */
import { S } from '../state';
import { el, clearChildren } from '../util';
import { iconSvg, type IconName } from '../icons';

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

/** 通用模态骨架（标题 + 可滚动 body；close 移除浮层）。提交摘要等自定义弹窗复用。 */
export function openModal(title: string): { box: HTMLElement; body: HTMLElement; close: () => void } {
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

/**
 * 新建标签对话框：名称必填；附注信息选填（非空 = 附注标签 annotated）。
 * 在 shaShort 所指提交上创建。
 */
export function tagDialog(
  shaShort: string,
  t: (k: string, p?: Record<string, string | number>) => string,
): Promise<{ name: string; message: string } | null> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(t('tagTitle', { sha: shaShort }));
    const nameLabel = el('label', 'gg-modal-label', t('tagNameLabel'));
    const nameInput = el('input', 'gg-input') as HTMLInputElement;
    nameInput.placeholder = 'v1.0.0';
    nameLabel.appendChild(nameInput);
    const msgLabel = el('label', 'gg-modal-label', t('tagMsgLabel'));
    const msgInput = el('textarea', 'gg-input gg-tag-msg') as HTMLTextAreaElement;
    msgInput.rows = 3;
    msgLabel.appendChild(msgInput);
    body.append(nameLabel, msgLabel);
    const btns = el('div', 'gg-modal-btns');
    const cancel = el('button', 'gg-btn', S.t('cancel'));
    const ok = el('button', 'gg-btn primary', t('tagCreateBtn'));
    const done = (v: { name: string; message: string } | null) => { close(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (name) done({ name, message: msgInput.value.trim() });
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && nameInput.value.trim()) done({ name: nameInput.value.trim(), message: msgInput.value.trim() }); });
    btns.append(cancel, ok);
    box.appendChild(btns);
    nameInput.focus();
  });
}

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

// ---------------- Notification（Issue #18 S2：右下通知，替代旧 toast） ----------------

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

export interface NotifyOpts {
  title: string;
  body?: string;
  /** 技术详情（git 输出尾等）：默认折叠，mono 展示（最多内部滚动） */
  detail?: string;
  actions?: { label: string; run(): void; primary?: boolean }[];
}

/** 停留时长（Issue #18 §2.2）：error 常驻（仅手动关闭或触发动作后关闭） */
const NOTIFY_MS: Record<NotifyLevel, number> = { info: 4000, success: 5000, warn: 8000, error: 0 };
const NOTIFY_ICON: Record<NotifyLevel, IconName> = { info: 'info', success: 'checkCircle', warn: 'warnTriangle', error: 'errorX' };
const NOTIFY_MAX = 4;

let notifHost: HTMLElement | undefined;
/** 超限折叠计数：最早的非常驻通知让位给新通知，计数行提示还有多少条 */
let notifHidden = 0;

function notifHostEl(): HTMLElement {
  if (!notifHost) {
    notifHost = el('div', 'gg-notifs');
    document.body.appendChild(notifHost);
  }
  return notifHost;
}

function refreshNotifCounter(): void {
  const h = notifHost!;
  let c = h.querySelector('.gg-notifs-more');
  if (notifHidden > 0) {
    if (!c) { c = el('div', 'gg-notifs-more'); h.appendChild(c); }
    c.textContent = S.t('notifMore', { n: notifHidden });
  } else c?.remove();
}

/** 堆叠上限：常驻 error 不挤；可见清零时计数一并复位 */
function trimNotifications(): void {
  if (!notifHost) return;
  const items = [...notifHost.querySelectorAll('.gg-notif')];
  let excess = items.length - NOTIFY_MAX;
  if (excess > 0) {
    for (const it of items) {
      if (excess <= 0) break;
      if (it.classList.contains('error')) continue;
      it.remove();
      notifHidden++;
      excess--;
    }
  }
  if (!notifHost.querySelectorAll('.gg-notif').length) notifHidden = 0;
  refreshNotifCounter();
}

export function notify(level: NotifyLevel, opts: NotifyOpts): void {
  const h = notifHostEl();
  const item = el('div', `gg-notif ${level}`);
  const head = el('div', 'gg-notif-head');
  head.appendChild(iconSvg(NOTIFY_ICON[level]));
  head.appendChild(el('span', 'gg-notif-title', opts.title));
  const x = el('button', 'gg-notif-x', '×');
  x.title = S.t('cancel');
  head.appendChild(x);
  item.appendChild(head);
  if (opts.body) item.appendChild(el('div', 'gg-notif-body', opts.body));
  if (opts.actions?.length) {
    const acts = el('div', 'gg-notif-acts');
    for (const a of opts.actions) {
      const b = el('button', 'gg-btn small' + (a.primary ? ' primary' : ''), a.label);
      b.addEventListener('click', () => { item.remove(); trimNotifications(); a.run(); });
      acts.appendChild(b);
    }
    item.appendChild(acts);
  }
  if (opts.detail) {
    const d = el('details', 'gg-notif-detail');
    d.appendChild(el('summary', undefined, S.t('gitOutput')));
    d.appendChild(el('pre', undefined, opts.detail));
    item.appendChild(d);
  }
  const remove = () => { item.remove(); trimNotifications(); };
  x.addEventListener('click', remove);
  h.insertBefore(item, h.querySelector('.gg-notifs-more') ?? null);
  trimNotifications();
  const ms = NOTIFY_MS[level];
  if (ms > 0) {
    setTimeout(() => item.classList.add('fade'), ms - 350);
    setTimeout(remove, ms);
  }
}

/** 旧签名兼容入口（info/warn/error 单行消息）：内部转发 Notification */
export function toast(level: 'info' | 'warn' | 'error', message: string, action?: { label: string; run: () => void }): void {
  notify(level, { title: message, actions: action ? [action] : undefined });
}
