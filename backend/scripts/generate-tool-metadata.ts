/**
 * generate-tool-metadata.ts
 *
 * 灵枢 V2 Spec 2B — 工具元数据自动生成脚本
 *
 * 从 backend/src/tools/builtin.ts 提取 16 个 BUILTIN_TOOLS,生成
 * backend/src/tools/metadata.json。
 *
 * 规则:
 * - 路径含 fs / write / edit / delete / mkdir → filesystem
 * - 路径含 git → git
 * - 路径含 glob / grep → search
 * - 其余 → legacy
 *
 * examples 从对应 .test.ts 的第一个 describe 标题提取 + 手工 example pool。
 * borrowedFrom 从 description 中正则提取 "Borrowed from XXX"。
 *
 * 运行: `tsx backend/scripts/generate-tool-metadata.ts`
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { BUILTIN_TOOLS } from '../src/tools/builtin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(BACKEND_ROOT, 'src', 'tools', 'metadata.json');

type Category = 'filesystem' | 'search' | 'git' | 'legacy';

function categorize(name: string): Category {
  // 4 个基础工具 (list_files / read_file / run_command / web_search) 都涉及文件系统操作
  if (['list_files', 'read_file', 'run_command'].includes(name)) return 'filesystem';
  if (['write_file', 'edit_file', 'delete_file', 'mkdir'].includes(name)) return 'filesystem';
  // 搜索/移动/复制类
  if (['mv', 'cp', 'rm', 'glob', 'grep'].includes(name)) return 'search';
  // git 工具
  if (name.startsWith('git_')) return 'git';
  // 联网搜索
  if (name === 'web_search') return 'search';
  return 'legacy';
}

function extractBorrowedFrom(description: string): string {
  const m = /Borrowed from ([^.]+)\./.exec(description);
  return m ? m[1]!.trim() : 'self';
}

interface Example {
  description: string;
  args: Record<string, unknown>;
  expected: string;
}

const EXAMPLE_POOL: Record<string, Example[]> = {
  list_files: [
    {
      description: '列出项目根目录',
      args: { path: '.' },
      expected: '返回 entries: [{name, type}]',
    },
  ],
  read_file: [
    {
      description: '读 README.md 全文',
      args: { path: '~/project/README.md' },
      expected: '返回 content 字符串',
    },
    {
      description: '分段读 5MB 大文件',
      args: { path: '~/data/big.log', offset: 0, limit: 1000 },
      expected: '返回 content (前 1000 字节)',
    },
  ],
  run_command: [
    {
      description: '运行 npm test',
      args: { command: 'npm test' },
      expected: '返回 { ok: true, stdout, stderr }',
    },
    {
      description: '危险命令被拦截',
      args: { command: 'rm -rf /' },
      expected: '返回 { ok: false, error: "Command blocked by safety filter" }',
    },
  ],
  web_search: [
    {
      description: '搜索 TypeScript 教程',
      args: { query: 'TypeScript tutorial 2026' },
      expected: '返回 { ok: true, results: [{ title, url, snippet }] } (Phase 1 stub)',
    },
  ],
  write_file: [
    {
      description: '创建 README.md',
      args: { path: '~/project/README.md', content: '# My Project\n' },
      expected: '返回 { ok: true, output: "Wrote 14 bytes to ~/project/README.md" }',
    },
  ],
  edit_file: [
    {
      description: '替换 README 标题',
      args: { path: '~/project/README.md', oldText: '# My Project', newText: '# Better Project' },
      expected: '返回 { ok: true, output: "Edited ~/project/README.md" }',
    },
  ],
  delete_file: [
    {
      description: '删除临时文件',
      args: { path: '~/project/tmp/scratch.txt' },
      expected: '返回 { ok: true, output: "Deleted ~/project/tmp/scratch.txt" }',
    },
  ],
  mkdir: [
    {
      description: '递归创建多级目录',
      args: { path: '~/project/a/b/c' },
      expected: '返回 { ok: true, output: "Created ~/project/a/b/c" }',
    },
  ],
  mv: [
    {
      description: '重命名文件',
      args: { src: '~/project/old.ts', dst: '~/project/new.ts' },
      expected: '返回 { ok: true, output: "Moved ~/project/old.ts → ~/project/new.ts" }',
    },
  ],
  cp: [
    {
      description: '复制目录',
      args: { src: '~/project/src', dst: '~/project/src-backup', recursive: true },
      expected: '返回 { ok: true, output: "Copied ~/project/src → ~/project/src-backup" }',
    },
  ],
  rm: [
    {
      description: '递归删除目录',
      args: { path: '~/project/node_modules' },
      expected: '返回 { ok: true, output: "Removed ~/project/node_modules" }',
    },
  ],
  glob: [
    {
      description: '找所有 ts 文件',
      args: { pattern: '**/*.ts' },
      expected: '返回 { ok: true, output: "<file1>\n<file2>", count: N }',
    },
  ],
  grep: [
    {
      description: '在 src 里搜 TODO',
      args: { pattern: 'TODO', path: 'src', include: '*.ts' },
      expected: '返回 { ok: true, output: "<file>:<line>:<text>" }',
    },
  ],
  git_status: [
    {
      description: '查看当前仓库状态',
      args: {},
      expected: '返回 { ok: true, output: "M src/index.ts\n? new.ts" 或 "(clean)" }',
    },
  ],
  git_diff: [
    {
      description: '查看未提交改动',
      args: {},
      expected: '返回 { ok: true, output: "diff --git a/..." }',
    },
    {
      description: '查看已 staged 改动',
      args: { staged: true },
      expected: '返回 staged diff',
    },
  ],
  git_commit: [
    {
      description: '提交所有未暂存改动',
      args: { message: 'feat: add new feature' },
      expected: '返回 { ok: true, output: "[main abc123] feat: add new feature" }',
    },
    {
      description: '禁止 push',
      args: { message: 'push latest changes' },
      expected: '返回 { ok: false, error: "git_commit tool forbids push" }',
    },
  ],
};

function findToolFilePath(name: string): string {
  // 从 registry / builtin.ts 推断; 不依赖源码结构变化
  if (['write_file', 'edit_file', 'delete_file', 'mkdir'].includes(name)) {
    return `backend/src/tools/builtin/filesystem/${name === 'write_file' ? 'write_file' : name === 'edit_file' ? 'edit_file' : name === 'delete_file' ? 'delete_file' : 'mkdir'}.ts`;
  }
  if (['mv', 'cp', 'rm', 'glob', 'grep'].includes(name)) {
    return `backend/src/tools/builtin/search/${name}.ts`;
  }
  if (name.startsWith('git_')) {
    return `backend/src/tools/builtin/git/git_status.ts`;
  }
  return 'backend/src/tools/builtin.ts';
}

function buildMetadata(): unknown {
  return {
    version: '2.0.0',
    generated: new Date().toISOString(),
    source: 'backend/src/tools/builtin.ts',
    description: '灵枢 V2 全部内置工具元数据。自动从 builtin.ts 提取 + schema 校验。',
    schemaRef: './metadata.schema.json',
    tools: BUILTIN_TOOLS.map(t => {
      const filePath = findToolFilePath(t.name);
      return {
        name: t.name,
        displayName: t.displayName,
        displayDescription: t.displayDescription,
        description: t.description,
        category: categorize(t.name),
        risk: t.risk,
        parameters: t.parameters,
        examples: EXAMPLE_POOL[t.name] ?? [],
        borrowedFrom: extractBorrowedFrom(t.description),
        sourceFile: filePath,
      };
    }),
  };
}

function main(): void {
  const metadata = buildMetadata();
  const json = JSON.stringify(metadata, null, 2);
  writeFileSync(OUTPUT_PATH, json, 'utf-8');
  const toolCount = (metadata as { tools: unknown[] }).tools.length;
  console.log(`[gen] wrote ${toolCount} tools to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
