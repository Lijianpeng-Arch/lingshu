/**
 * Tool Registry — per-surface profiles + built-in name protection
 *
 * Borrowed from BaiLongma `capabilities/marketplace/BUILTIN_NAMES` and
 * Hermes `cli-config.yaml.platform_toolsets`.
 */

export type RiskLevel = 'low' | 'medium' | 'high';
export type Surface = 'desktop' | 'tray' | 'cli';

export interface ToolDefinition {
  name: string;
  description: string;
  displayName: string;
  displayDescription: string;
  parameters: Record<string, unknown>;
  risk: RiskLevel;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export class ToolNameProtectedError extends Error {
  constructor(name: string) {
    super(`Tool name "${name}" is a protected built-in and cannot be overridden`);
    this.name = 'ToolNameProtectedError';
  }
}

const BUILTIN_PROTECTED_NAMES: ReadonlySet<string> = new Set([
  'send_message', 'read_file', 'write_file', 'exec_command', 'delete_file',
]);

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  registerMany(tools: ToolDefinition[]): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  setProfile(surface: Surface, names: string[]): void;
  getProfile(surface: Surface): string[];
  getProfileTools(surface: Surface): ToolDefinition[];
  readonly protectedNames: ReadonlySet<string>;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const profiles = new Map<Surface, string[]>();
  return {
    protectedNames: BUILTIN_PROTECTED_NAMES,
    register(tool) {
      if (!tool.displayName?.trim()) throw new Error(`Tool "${tool.name}" is missing displayName (中文展示名)`);
      if (!tool.displayDescription?.trim()) throw new Error(`Tool "${tool.name}" is missing displayDescription (中文描述)`);
      tools.set(tool.name, tool);
    },
    registerMany(ts) { for (const t of ts) this.register(t); },
    unregister(name) {
      if (BUILTIN_PROTECTED_NAMES.has(name)) throw new ToolNameProtectedError(name);
      tools.delete(name);
    },
    get(name) { return tools.get(name); },
    list() { return [...tools.values()]; },
    setProfile(surface, names) { profiles.set(surface, names); },
    getProfile(surface) { return profiles.get(surface) ?? []; },
    getProfileTools(surface) {
      const names = profiles.get(surface) ?? [];
      const out: ToolDefinition[] = [];
      for (const n of names) { const t = tools.get(n); if (t) out.push(t); }
      return out;
    },
  };
}
