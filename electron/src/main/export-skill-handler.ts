/**
 * Export-skill IPC handler — refactored to be testable.
 *
 * The dialog + filesystem calls are dependency-injected so we can
 * unit test with mocks (vitest, no Electron runtime needed).
 *
 * Production wiring: main.ts registers `ipcMain.handle('skill:export', (_, skill) => ...)`.
 */

import { exportSkill as writeSkillPackage } from './export-skill.js';
import type { SkillDefinition } from '@lingshu/shared-types';

/**
 * Minimal contract for `dialog.showSaveDialog` so we can mock it in tests.
 */
export interface SaveDialog {
  showSaveDialog: (window: unknown, options: {
    title: string;
    defaultPath?: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
}

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

/**
 * Prompt the user for a save path, then write the skill package to disk.
 *
 * @param dialog - electron `dialog` module (or a mock)
 * @param skill   - skill definition from the renderer
 * @param win     - parent BrowserWindow (passed to showSaveDialog so the sheet is modal)
 */
export async function handleExportSkill(
  dialog: SaveDialog,
  skill: SkillDefinition,
  win: unknown = null,
): Promise<ExportResult> {
  const defaultFileName = `${skill.name}-${skill.version ?? '1.0.0'}.skill`;
  try {
    const choice = await dialog.showSaveDialog(win, {
      title: '导出技能',
      defaultPath: defaultFileName,
      filters: [{ name: '灵枢技能包', extensions: ['skill'] }],
    });
    if (choice.canceled || !choice.filePath) {
      return { ok: false, cancelled: true };
    }
    await writeSkillPackage(skill, choice.filePath);
    return { ok: true, path: choice.filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'export failed' };
  }
}
