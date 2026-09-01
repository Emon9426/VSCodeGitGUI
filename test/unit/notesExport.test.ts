/** 快速笔记：Markdown 导出降级规则 + HTML 往返 + notePath 防御（v0.15.0） */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { docToMarkdown } from '../../src/notes/exportMd';
import { buildExportHtml } from '../../src/notes/exportHtml';
import { parseNoteHtml, createNote, listNotes, readNote, saveNote, renameNote, deleteNote, notePath, slugify, uniqueId } from '../../src/notes/notesStore';

describe('exportMd 降级规则', () => {
  it('标题/段落/行内代码/代码块/分割线保真', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '一、进展' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '前缀 ' }, { type: 'text', marks: [{ type: 'code' }], text: 'code_x' }, { type: 'text', text: ' 后缀' }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] },
        { type: 'horizontalRule' },
      ],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('## 一、进展');
    expect(md).toContain('`code_x`');
    expect(md).toContain('```ts');
    expect(md).toContain('const a = 1;');
    expect(md).toContain('---');
  });

  it('合并单元格拆平（colspan 占位空列、rowspan 空行位）', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '宽表头' }] }] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
          ] },
        ],
      }],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('| 宽表头 |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| a | b |');
  });

  it('嵌套表格压平为行内列表文本', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableCell',
            content: [{
              type: 'table',
              content: [{
                type: 'tableRow',
                content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '内表' }] }] }],
              }],
            }],
          }],
        }],
      }],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('内表');
    expect(md).not.toMatch(/\n\s*\|.*\|.*\n\s*\| --- /);   // 内表不再产出独立表格分隔行
  });

  it('卡片降级为 blockquote + emoji', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'callout',
        attrs: { kind: 'warn', title: '注意' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '灰度中' }] }],
      }],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('> ⚠️ **注意**');
    expect(md).toContain('> 灰度中');
  });

  it('画板：有 href 出图片引用，无 href 留注释占位', () => {
    const mk = (attrs: Record<string, unknown>) => ({
      type: 'doc', content: [{ type: 'sketch', attrs }],
    });
    expect(docToMarkdown(mk({ title: '流程', href: './流程.svg' }) as any)).toContain('![流程](./流程.svg)');
    expect(docToMarkdown(mk({ title: '流程' }) as any)).toContain('sketch "流程" removed');
    const withHook = docToMarkdown(mk({ title: 'k1' }) as any, { sketchHrefOf: t => `./${t}.svg` });
    expect(withHook).toContain('![k1](./k1.svg)');
  });

  it('图片：data URL 原样内嵌 Markdown，alt 去方括号', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'gbImage', attrs: { src: 'data:image/png;base64,AAAA', alt: '截图[1]' } },
        { type: 'gbImage', attrs: { alt: 'no-src' } },
      ],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('![截图1](data:image/png;base64,AAAA)');
    expect(md).toContain('<!-- image missing -->');
  });

  it('待办列表转 GFM task list', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '完成' }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }] },
        ],
      }],
    };
    const md = docToMarkdown(doc as any);
    expect(md).toContain('- [x] 完成');
    expect(md).toContain('- [ ] 待办');
  });
});

describe('HTML 往返', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '往返 <测试> 内容' }] }] };

  it('导出 HTML 内嵌数据块且可无损解析', () => {
    const html = buildExportHtml('标题', doc, '<p>渲染体</p>', '2026-08-30T00:00:00Z');
    expect(html).toContain('<script type="application/json" id="gitboard-note">');
    expect(html).toContain('<p>渲染体</p>');
    const back = parseNoteHtml(html);
    expect(back).toBeDefined();
    expect(back!.title).toBe('标题');
    expect(JSON.stringify(back!.doc)).toBe(JSON.stringify(doc));
  });

  it('普通 HTML 无数据块时返回 undefined', () => {
    expect(parseNoteHtml('<html><body><p>纯网页</p></body></html>')).toBeUndefined();
    expect(parseNoteHtml('<script id="gitboard-note">not json</script>')).toBeUndefined();
  });
});

describe('notesStore CRUD 与路径防御', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-notes-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('slugify 剔除非法字符', () => {
    expect(slugify('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(slugify('  标题 ')).toBe('标题');
    expect(slugify('   ')).toBe('note');
  });

  it('创建/列表/读取/保存/重命名/删除闭环 + 同名去重', () => {
    const a = createNote(dir, '会议');
    const b = createNote(dir, '会议');
    expect(b.id).toBe('会议-2');
    expect(listNotes(dir)).toHaveLength(2);
    saveNote(dir, a.id, { type: 'doc', content: [] }, '会议新名');
    expect(readNote(dir, a.id).meta.title).toBe('会议新名');
    const rn = renameNote(dir, a.id, '最终名');
    expect(rn.id).toBe('最终名');
    expect(fs.existsSync(path.join(dir, '会议新名' + '.gbnote.json'))).toBe(false);
    deleteNote(dir, b.id);
    expect(listNotes(dir)).toHaveLength(1);
    expect(uniqueId(dir, '最终名')).toBe('最终名-2');
  });

  it('notePath 拒绝穿越与非法 id', () => {
    expect(() => notePath(dir, '..')).toThrow();
    expect(() => notePath(dir, 'a/b')).toThrow();
    expect(() => notePath(dir, '.hidden')).toThrow();
    const p = notePath(dir, '正常');
    expect(p.startsWith(path.resolve(dir) + path.sep)).toBe(true);
  });
});
