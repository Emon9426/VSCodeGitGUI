/**
 * RPC 闸门命令分类契约测试（Issue #75）：git 无关命令集（rpcGate.ts）包含工程目录
 * 全家与界面持久化等——这些在仓库扫描/首仓库解析完成前即可路由；git 核心命令必须
 * 留在闸门内（等 ensureRepos，防 service/runner 未就绪时报错）。集合是防回归契约：
 * 新增命令归类错误（误旁路/漏旁路）会在本测试暴露。
 */
import { describe, expect, it } from 'vitest';
import { GIT_FREE_CMDS } from '../../src/webview/rpcGate';

describe('GIT_FREE_CMDS（Issue #75）', () => {
  it('工程目录五命令全部旁路（本次解耦的主体）', () => {
    for (const cmd of ['projects.add', 'projects.rename', 'projects.remove', 'projects.pickFolder', 'projects.open']) {
      expect(GIT_FREE_CMDS.has(cmd), cmd).toBe(true);
    }
  });

  it('界面偏好持久化与纯 UI / 环境 / LM 查询命令旁路', () => {
    for (const cmd of [
      'ui:saveColWidths', 'ui:saveDetailPct', 'ui:saveFilesLayout', 'ui:saveSideCollapsed',
      'ui:saveBranchGroups', 'ui:saveNotifyWidth', 'ui:saveSideWidth', 'work.saveLayout',
      'ui:copy', 'ui:openSettings', 'ui:pickLanguage', 'ui:setView',
      'pullHistory', 'work.aiModels', 'work.aiCancel',
      'err.aiDiagnose', 'err.aiDiagnoseCancel',
    ]) {
      expect(GIT_FREE_CMDS.has(cmd), cmd).toBe(true);
    }
  });

  it('git 核心命令不旁路——须等仓库扫描就绪（防 service 未就绪抛错）', () => {
    for (const cmd of [
      'selectRepo', 'refresh', 'loadMore', 'commitDetail', 'diff', 'setFilter', 'listAuthors',
      'work.state', 'work.commit', 'work.diff', 'work.saveDraft', 'work.loadDraft',
      'files.ls', 'folder.delete', 'folder.move',
      'op:fetch', 'op:pull', 'op:push', 'op:checkout', 'op:cancel',
      'merge.session', 'tag.create', 'branch.delete', 'pr.open',
      'work.aiGenerate', 'err.aiFixStep',
      'ui:openFile', 'ui:openDiffEditor', 'ui:revealInFM',
    ]) {
      expect(GIT_FREE_CMDS.has(cmd), cmd).toBe(false);
    }
  });
});
