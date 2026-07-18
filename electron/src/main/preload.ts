/**
 * Preload — contextBridge for renderer IPC
 *
 * 仅暴露 renderer 实际调用的 IPC,精简 V6 时代遗留:
 * - apiRequest:     后端 HTTP 代理 (main.ts 注册 api:request handler)
 * - exportSkill:    技能导出 (v0.2 留)
 * - selectSkillDirectory: 本地目录选择 (v0.2 留)
 */

// CJS-style require for electron (avoid `import * as electron` CJS namespace bug)
const { contextBridge, ipcRenderer } = require('electron');

/** 技能导出 — 把 SkillDefinition 打包成 .skill 文件并存到用户选定路径 */
export type SkillExportResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

/** 本地技能安装 — popup 系统选择目录对话框,返回 { ok, path } 或 { ok:false, cancelled:true } */
export type SelectSkillDirResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true };

export interface LingshuAPI {
  exportSkill: (skill: unknown) => Promise<SkillExportResult>;
  selectSkillDirectory: () => Promise<SelectSkillDirResult>;
  /** Spec 1: 由 main 进程 net.fetch 代理 renderer HTTP 请求,绕开 file:// CSP/fetch 限制 */
  apiRequest: (opts: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    backendUrl?: string;
  }) => Promise<{ status: number; ok: boolean; body: string }>;
}

const api: LingshuAPI = {
  exportSkill: (skill) => ipcRenderer.invoke('skill:export', skill),
  selectSkillDirectory: () => ipcRenderer.invoke('skill:select-directory'),
  apiRequest: (opts) => ipcRenderer.invoke('api:request', opts),
};

contextBridge.exposeInMainWorld('lingshu', api);