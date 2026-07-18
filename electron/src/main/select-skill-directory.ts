import type { BrowserWindow } from 'electron';
import { dialog as electronDialog } from 'electron';

export async function selectSkillDirectory(
  dialog: Pick<typeof electronDialog, 'showOpenDialog'> = electronDialog,
  win: BrowserWindow | null = null,
) {
  // BrowserWindow extends BaseWindow,但 TS 类型签名太严,直接用 any 透传
  const result = await (dialog.showOpenDialog as (w: unknown, opts: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>)(
    win ?? undefined,
    {
      title: '选择已解包的技能目录',
      properties: ['openDirectory'],
    },
  );
  if (result.canceled || !result.filePaths[0]) return { ok: false as const, cancelled: true as const };
  return { ok: true as const, path: result.filePaths[0] };
}