import { describe, expect, it, vi } from 'vitest';
import { selectSkillDirectory } from './select-skill-directory.js';

describe('selectSkillDirectory', () => {
  it('returns selected directory', async () => {
    const dialog = { showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['D:/skills/weather'] }) };
    await expect(selectSkillDirectory(dialog as any, null)).resolves.toEqual({ ok: true, path: 'D:/skills/weather' });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(undefined, expect.objectContaining({ properties: ['openDirectory'] }));
  });

  it('returns cancelled without an undefined error', async () => {
    const dialog = { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) };
    await expect(selectSkillDirectory(dialog as any, null)).resolves.toEqual({ ok: false, cancelled: true });
  });
});
