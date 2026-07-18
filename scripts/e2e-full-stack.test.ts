/**
 * E2E — Full-stack integration: backend + soul + electron
 *
 * 目标: 端到端跑通真实链路 — 用户在 Electron chat input 里发 "你好",
 *      backend 收到 chat.request → 调 LLM → 流式回 chat.delta → renderer
 *      把内容追加进 MessageBubble, 验证有 ≥2 个中文字符。
 *
 * 启动链路:
 *   1. backend  `tsx backend/src/server.ts`  PORT=3199  (loopback only)
 *   2. soul     `uv run soul/src/soul/api.py`  port=3899  (内存 + 简单 mock)
 *   3. electron  ELECTRON_RUN_AS_NODE=1 跑 electron-vite preview + electron 主进程
 *               用 VITE_LINGSHU_BACKEND_URL=http://127.0.0.1:3199 重定向 renderer
 *
 * CI guard: 默认 SKIP_E2E=1 时整个 suite test.skip, 不跑。跑法:
 *   cd D:/lingshu/lingshu && SKIP_E2E=0 npm run test:e2e:full
 *
 * 注意:
 *   - 真 LLM key 是必要条件 (LINGSHU_DEEPSEEK_API_KEY 等)。没有会失败。
 *   - Windows headless 需 LINGSHU_DISABLE_GPU=1 + LINGSHU_DISABLE_SANDBOX=1。
 *   - 进程清理走 try/finally, 即使断言失败也会关 Electron + 杀 backend。
 */

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = 'D:/lingshu/lingshu';
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3199);
const SOUL_PORT = Number(process.env.E2E_SOUL_PORT ?? 3899);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const SOUL_URL = `http://127.0.0.1:${SOUL_PORT}`;

const SHOULD_SKIP = process.env['SKIP_E2E'] === '1' || process.env['SKIP_E2E'] === 'true';

// =============================================================================
// 进程管理
// =============================================================================

interface ProcHandle {
  proc: ChildProcess;
  kind: 'backend' | 'soul' | 'electron';
}

function killTree(child: ChildProcess | undefined): void {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForHttp(url: string, timeoutMs = 30_000, intervalMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || (res.status >= 200 && res.status < 500)) return;
    } catch { /* not up yet */ }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${url}`);
}

function spawnBackend(): ProcHandle {
  const env = {
    ...process.env,
    PORT: String(BACKEND_PORT),
    HOST: '127.0.0.1',
    // 端到端走真链路 — 强制 SKIP_MOCK_TOOLS 关闭, 真 LLM 跑 stream。
    LINGSHU_MOCK_TOOLS: '0',
  } as NodeJS.ProcessEnv;

  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const proc = spawn(cmd, ['--workspace', 'backend', 'exec', '--', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  return { proc, kind: 'backend' };
}

function spawnSoul(): ProcHandle {
  const env = {
    ...process.env,
    LINGSHU_SOUL_PORT: String(SOUL_PORT),
    LINGSHU_SOUL_HOST: '127.0.0.1',
  } as NodeJS.ProcessEnv;

  const proc = spawn('uv', ['run', 'python', '-m', 'soul.api'], {
    cwd: `${ROOT}/soul`,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => process.stdout.write(`[soul] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[soul] ${d}`));
  return { proc, kind: 'soul' };
}

async function launchElectron(): Promise<{ app: ElectronApplication; firstWindow: Page; }> {
  const env = {
    ...process.env,
    VITE_LINGSHU_BACKEND_URL: BACKEND_URL,
    LINGSHU_BACKEND_URL: BACKEND_URL,
    LINGSHU_DISABLE_GPU: '1',
    LINGSHU_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  } as NodeJS.ProcessEnv;

  // electron-vite preview 先把 renderer 编译 + 起静态服务, 然后 electron 主进程加载。
  // 这里直接调 electron CLI, 用 out/main/main.js (electron-vite build 的产物)。
  // 在 preview 模式下, renderer 由 vite serve, electron 主进程用 file:// 加载。
  const electronBin = `${ROOT}/electron/node_modules/.bin/${process.platform === 'win32' ? 'electron.cmd' : 'electron'}`;
  const mainEntry = `${ROOT}/electron/out/main/main.js`;

  const app = await _electron.launch({
    executablePath: electronBin,
    args: [mainEntry],
    env,
    cwd: `${ROOT}/electron`,
    timeout: 30_000,
  });
  const firstWindow = await app.firstWindow({ timeout: 30_000 });
  await firstWindow.waitForLoadState('domcontentloaded');
  return { app, firstWindow };
}

// =============================================================================
// Suite
// =============================================================================

test.describe('E2E full-stack: backend + soul + electron', () => {
  test.skip(SHOULD_SKIP, 'SKIP_E2E=1 — 跳过全栈 E2E (需真 LLM key + 60s)');

  let backend: ProcHandle | undefined;
  let soul: ProcHandle | undefined;
  let electronApp: ElectronApplication | undefined;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    // 1) 起 backend
    backend = spawnBackend();
    await waitForHttp(`${BACKEND_URL}/api/health`, 30_000);

    // 2) 起 soul — 失败也继续 (backend 在 no-soul 模式能跑)
    soul = spawnSoul();
    try {
      await waitForHttp(`${SOUL_URL}/health`, 15_000);
    } catch {
      console.warn('[e2e] soul not reachable, continuing without soul bridge');
    }

    // 3) 起 electron
    ({ app: electronApp } = await launchElectron());
  });

  test.afterAll(async () => {
    if (electronApp) {
      try { await electronApp.close(); } catch { /* ignore */ }
      electronApp = undefined;
    }
    killTree(backend?.proc);
    killTree(soul?.proc);
    backend = undefined;
    soul = undefined;
  });

  test('用户发 "你好" → MessageBubble 出现非空内容 + ≥2 个中文字符', async () => {
    test.setTimeout(90_000);
    expect(electronApp, 'electron must be launched in beforeAll').toBeDefined();
    const page = await electronApp!.firstWindow();

    // 等 ChatPage 渲染 — chat-input 是 renderer's testid (见 e2e-electron-ui.mjs)
    const chatInput = page.locator('[data-testid="chat-input"]');
    await chatInput.waitFor({ state: 'visible', timeout: 15_000 });

    // 输入 + 发送 "你好"
    await chatInput.click();
    await chatInput.fill('你好');
    await page.locator('[data-testid="send-button"]').click();

    // 等用户消息 bubble 先出现 (你: 你好)
    const userBubble = page.locator('text=你好').first();
    await userBubble.waitFor({ state: 'visible', timeout: 5_000 });

    // 等 assistant bubble 出现 — 至少有一个非 system 的 MessageBubble 有内容
    // MessageBubble 渲染后, 其内层 <div class="whitespace-pre-wrap ...">{content}</div> 是 chat content
    // 我们等任意 .whitespace-pre-wrap 不为空的元素
    const contentCell = page.locator('.whitespace-pre-wrap').last();
    await contentCell.waitFor({ state: 'visible', timeout: 60_000 });

    // 给 LLM 流式追加一个缓冲
    await sleep(2_000);

    const allBubbles = page.locator('.whitespace-pre-wrap');
    const count = await allBubbles.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // 找 assistant 回复 — 它是 messages 数组里 role !== 'user' && role !== 'system' 的最后一个
    let assistantText = '';
    for (let i = count - 1; i >= 0; i--) {
      const txt = (await allBubbles.nth(i).innerText()).trim();
      if (txt && txt !== '你好') {
        assistantText = txt;
        break;
      }
    }

    expect(assistantText.length).toBeGreaterThan(0);
    // 至少 2 个中文字符
    const chineseMatches = assistantText.match(/[一-鿿]/g) ?? [];
    expect(chineseMatches.length, `expected ≥2 Chinese chars in "${assistantText}"`)
      .toBeGreaterThanOrEqual(2);
  });
});