/**
 * 正文图片（v0.17 反馈 #7）：块级 atom 图片节点 + 选中后四角拖拽调宽 + 粘贴/拖放图片直接嵌入。
 * 图片以 data URL 内嵌在 doc JSON 中（.gbnote.json 单文件自包含，CSP img-src 已放行 data:）。
 * 入口：工具栏 🖼 按钮（宿主 notes.pickImage 系统对话框）/ 粘贴 / 拖放。
 */
import { Node, Extension, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { mkNodeDelBtn } from './blockdel';

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    gbImage: {
      /** 光标处插入图片 */
      insertGbImage(options: { src: string; alt?: string }): ReturnType;
    };
  }
}

export const GbImage = Node.create({
  name: 'gbImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      /** 显示宽度 px（null = 原始尺寸，上限受容器约束） */
      width: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-gb-img]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = node.attrs.width ? `width:${Number(node.attrs.width)}px;` : '';
    return ['img', mergeAttributes({ 'data-gb-img': '1', style }, HTMLAttributes)];
  },

  addCommands() {
    return {
      insertGbImage: (options: { src: string; alt?: string }) => ({ chain }) =>
        chain().insertContent({ type: this.name, attrs: options }).run(),
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrap = document.createElement('div');
      wrap.className = 'gg-img';
      const img = document.createElement('img');
      img.draggable = false;
      const apply = (n: PMNode): void => {
        img.src = String(n.attrs.src ?? '');
        img.alt = String(n.attrs.alt ?? '');
        wrap.style.width = n.attrs.width ? `${Number(n.attrs.width)}px` : '';
      };
      apply(node);
      wrap.appendChild(img);
      // v0.18 反馈 #9：选中（NodeSelection）后右上角显示删除按钮
      const t = (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k);
      wrap.appendChild(mkNodeDelBtn(editor, getPos, t('notesDeleteBlock')));
      // 四角手柄：选中（NodeSelection）后出现，拖拽改宽度（等比，高度 auto）
      const corners = ['nw', 'ne', 'sw', 'se'] as const;
      const onMove = (e: PointerEvent): void => {
        if (!sizing) return;
        const factor = sizing.corner.includes('w') ? -1 : 1;
        const w = Math.max(48, Math.min(1600, Math.round(sizing.startW + (e.clientX - sizing.startX) * factor)));
        wrap.style.width = `${w}px`;
      };
      const onUp = (): void => {
        if (!sizing) return;
        sizing = undefined;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const w = Math.round(wrap.getBoundingClientRect().width);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: w }));
      };
      let sizing: { corner: string; startX: number; startW: number } | undefined;
      for (const corner of corners) {
        const h = document.createElement('span');
        h.className = `gg-img-h ${corner}`;
        h.addEventListener('pointerdown', e => {
          e.preventDefault();
          e.stopPropagation();
          sizing = { corner, startX: e.clientX, startW: wrap.getBoundingClientRect().width };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        });
        wrap.appendChild(h);
      }
      return {
        dom: wrap,
        update(newNode) {
          if (newNode.type.name !== 'gbImage') return false;
          node = newNode;
          apply(newNode);
          return true;
        },
        selectNode() { wrap.classList.add('sel'); },
        deselectNode() { wrap.classList.remove('sel'); },
        ignoreMutation() { return true; },
      };
    };
  },
});

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(`read failed: ${file.name}`));
    fr.readAsDataURL(file);
  });
}

async function insertFiles(view: EditorView, files: File[], at?: { x: number; y: number }): Promise<void> {
  for (const file of files.slice(0, 3)) {
    if (!file.type.startsWith('image/') || file.size > IMAGE_MAX_BYTES) continue;
    try {
      const src = await readFileAsDataUrl(file);
      const node = view.state.schema.nodes.gbImage!.create({ src, alt: file.name.slice(0, 60) });
      const tr = view.state.tr;
      if (at) {
        const hit = view.posAtCoords({ left: at.x, top: at.y });
        if (hit) tr.insert(hit.pos, node);
        else tr.replaceSelectionWith(node);
      } else {
        tr.replaceSelectionWith(node);
      }
      view.dispatch(tr.scrollIntoView());
    } catch { /* 单个文件失败跳过 */ }
  }
}

/** 粘贴/拖放图片导入（与宿主对话框同源 data URL） */
export const ImageInput = Extension.create({
  name: 'gbImageInput',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
            if (!files.length) return false;
            event.preventDefault();
            void insertFiles(view, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
            if (!files.length) return false;
            event.preventDefault();
            const de = event as DragEvent;
            void insertFiles(view, files, de.clientX !== 0 || de.clientY !== 0 ? { x: de.clientX, y: de.clientY } : undefined);
            return true;
          },
        },
      }),
    ];
  },
});
