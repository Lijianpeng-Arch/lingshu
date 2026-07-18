import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { handleExportSkill, type SaveDialog } from './export-skill-handler.js';

const sampleSkill = {
  name: 'weather-lookup',
  displayName: '天气查询',
  description: '查指定城市的实时天气',
  version: '1.0.0',
  lingshuMinVersion: '2.0.0',
};

function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-export-test-'));
}

describe('handleExportSkill — happy path', () => {
  it('writes the skill package to the chosen path and returns { ok: true, path }', async () => {
    const tmpDir = await makeTmpDir();
    const expectedPath = path.join(tmpDir, 'weather-lookup-1.0.0.skill');
    const dialog: SaveDialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: expectedPath }),
    };

    const result = await handleExportSkill(dialog, sampleSkill as any, null);
    expect(result).toEqual({ ok: true, path: expectedPath });

    // Verify the file was actually written and is a valid zip
    const bytes = await fs.readFile(expectedPath);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['manifest.json', 'tools/', 'README.md']));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses default filename pattern <name>-<version>.skill', async () => {
    let capturedDefault: string | undefined;
    const dialog: SaveDialog = {
      showSaveDialog: vi.fn().mockImplementation(async (_w, opts) => {
        capturedDefault = opts.defaultPath;
        // Return a real writable tmp path with that default filename
        const tmpDir = await makeTmpDir();
        return { canceled: false, filePath: path.join(tmpDir, opts.defaultPath ?? 'x.skill') };
      }),
    };
    const result = await handleExportSkill(dialog, sampleSkill as any, null);
    expect(capturedDefault).toBe('weather-lookup-1.0.0.skill');
    expect(result.ok).toBe(true);
    if (result.ok) {
      await fs.rm(path.dirname(result.path), { recursive: true, force: true });
    }
  });
});

describe('handleExportSkill — cancel path', () => {
  it('returns { ok: false, cancelled: true } when user cancels', async () => {
    const dialog: SaveDialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    };
    const result = await handleExportSkill(dialog, sampleSkill as any, null);
    expect(result).toEqual({ ok: false, cancelled: true });
  });

  it('returns { ok: false, cancelled: true } when no filePath returned', async () => {
    const dialog: SaveDialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false }),
    };
    const result = await handleExportSkill(dialog, sampleSkill as any, null);
    expect(result).toEqual({ ok: false, cancelled: true });
  });
});

describe('handleExportSkill — error path', () => {
  it('returns { ok: false, error } when showSaveDialog throws', async () => {
    const dialog: SaveDialog = {
      showSaveDialog: vi.fn().mockRejectedValue(new Error('对话框初始化失败')),
    };
    const result = await handleExportSkill(dialog, sampleSkill as any, null);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error).toBe('对话框初始化失败');
    }
  });
});
