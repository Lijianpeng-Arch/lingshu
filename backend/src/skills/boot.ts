/**
 * 技能启动加载 — Spec 1 C4
 *
 * boot 时扫 ~/.lingshu/skills/,校验每个 manifest,失败则硬退出。
 * Spec §2.1 B 承诺: "启动时报错"。
 *
 * 设计原则:
 * - bootSkills 是一个独立函数,可被 server.ts 调用,也可被测试直接调用
 * - 启动失败 → 抛 Error(server.ts 用 try/catch 翻译成 process.exit(1))
 * - 成功 → 返回加载到的 SkillDefinition[],并 console.log
 *
 * Task 4: defaultSkillsDir 已下移到 ./paths.ts,本文件只保留 re-export
 * 避免循环依赖并让 boot/storage/installer 共用同一路径解析。
 */

import { loadSkills } from './registry.js';
import { defaultSkillsDir } from './paths.js';
import { loadMcpConfigs, defaultMcpDir } from '../mcp/registry.js';
import type { SkillDefinition } from './types.js';

// re-export 让现有 import (boot.test.ts 等) 继续可用
export { defaultSkillsDir } from './paths.js';
export { defaultMcpDir, loadMcpConfigs } from '../mcp/registry.js';

export class SkillsBootError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SkillsBootError';
  }
}

export interface BootSkillsOptions {
  /** 默认 ~/.lingshu/skills */
  skillsDir?: string;
  /** 默认 ~/.lingshu/mcp */
  mcpDir?: string;
  /** 日志输出函数,默认 console.log */
  log?: (msg: string) => void;
  /** 错误输出函数,默认 console.error */
  logError?: (msg: string) => void;
}

export async function bootSkills(opts: BootSkillsOptions = {}): Promise<SkillDefinition[]> {
  const skillsDir = opts.skillsDir ?? defaultSkillsDir();
  const log = opts.log ?? ((m) => console.log(m));
  const logError = opts.logError ?? ((m) => console.error(m));

  try {
    const skills = await loadSkills(skillsDir);
    const names = skills.map((s) => s.displayName).join(', ');
    log(`[boot] Loaded ${skills.length} skill(s) from ${skillsDir}: [${names}]`);
    // W5: 同时扫一下 mcp 配置目录, 仅日志, 不强制 (mcp 是可选, 没有 mcp 配置目录属正常)。
    // 实际 spawn + 注册在 mainLoop.start() 里 (通过 mcpRegistry)。
    const mcpDir = opts.mcpDir ?? defaultMcpDir();
    const mcpConfigs = await loadMcpConfigs(mcpDir, logError);
    if (mcpConfigs.length > 0) {
      log(`[boot] 发现 ${mcpConfigs.length} 个 MCP 配置 (${mcpDir}): [${mcpConfigs.map(c => c.name).join(', ')}]`);
    }
    return skills;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`[boot] Skill loading failed from ${skillsDir}: ${errMsg}`);
    throw new SkillsBootError(`Skill loading failed: ${errMsg}`, err);
  }
}