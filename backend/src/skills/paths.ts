/**
 * 技能路径 — 仅本 Task 7 唯一需要,作为最小实现放在 routes.ts 同目录。
 * 默认 ~/.lingshu/skills,可由 LINGSHU_SKILLS_DIR 环境变量覆盖。
 */
import * as os from 'node:os';
import * as path from 'node:path';

export function defaultSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LINGSHU_SKILLS_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.lingshu', 'skills');
}
