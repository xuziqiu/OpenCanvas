import type { OpenCanvasAppInfo } from '../types';

interface DiagnosticWorkspaceSummary {
  cards: number;
  boards: number;
  folders: number;
  projects: number;
  saveState: string;
  integrityIssues?: number;
}

export function formatDiagnosticSummary(info: OpenCanvasAppInfo, workspace: DiagnosticWorkspaceSummary) {
  return [
    'OpenCanvas 诊断信息',
    `应用版本: ${info.appVersion}`,
    `运行模式: ${info.packaged ? '已打包桌面版' : info.electronVersion ? 'Electron 开发版' : '浏览器测试版'}`,
    `Electron: ${info.electronVersion ?? '不适用'}`,
    `Chromium: ${info.chromiumVersion || '未知'}`,
    `Node: ${info.nodeVersion ?? '不适用'}`,
    `系统: ${info.platform} ${info.arch}`,
    `知识库: ${info.vaultPath}`,
    `保存状态: ${workspace.saveState}`,
    `对象数量: ${workspace.cards} 张卡片 / ${workspace.boards} 块白板 / ${workspace.folders} 个文件夹 / ${workspace.projects} 个项目`,
    `完整性问题: ${workspace.integrityIssues ?? '尚未检查'}`,
    `生成时间: ${new Date().toISOString()}`,
    '',
    '说明: 此摘要不包含笔记正文、附件内容或文件清单。',
  ].join('\n');
}
