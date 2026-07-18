/**
 * chat Handler — 把 chatStream 折成 chat.delta / chat.done 事件
 *
 * Borrowed from BaiLongma `runTurnWithWatchdog()` 的 Watchdog 模式。
 */

import type { Provider, Capability, ClassifiedError } from '../providers/types.js';
import type {
  UACSEnvelope, UACSEnvelopeType,
  ChatDeltaPayload, ChatDonePayload,
} from '../uacs/envelope.js';
import { withWatchdog, WatchdogTimeout } from '../tick/watchdog.js';
import { classifyError } from '../providers/errors.js';
import { newId } from '../util/id.js';
import { ContextCompressor, ContextOverflowError } from './context-compressor.js';
import { buildToolPreview } from './tool-preview.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import type { ToolDefinition } from '../tools/registry.js';
import { emitCapabilityInvoke, awaitCapabilityResult } from '../uacs/dispatcher.js';
import type { MainLoop } from '../agent/main-loop.js';
import { emitToolCall, type ToolCallStartEvent, type ToolCallResultEvent } from '../envelopes/tool-call.js';
import type { AgentContext } from '../agent/goal.js';
import type { LLMProvider } from '../agent/verifier.js';
import type { Settings } from '../permission/settings.js';
import { loadSettings } from '../permission/settings.js';
import { createChatTrigger, _clearWizardSessionsForTest as _triggerClearWizardSessions, _getWizardSessionForTest as _triggerGetWizardSession, _getWizardByChatSessionForTest as _triggerGetWizardByChatSession, type ChatTrigger } from '../skills/chat-trigger.js';
import type { WizardSession } from '../skills/conversational-state.js';

export interface ChatHandlerDeps {
  emit: (env: UACSEnvelope) => void;
  getProvider: (cap: Capability) => Provider;
  timeoutMs?: number;
  now?: () => number;
  /** 可选:传入则长对话自动压缩;不传保持原行为 */
  compressor?: ContextCompressor;
  /** 可选: MainLoop 接入 (Task 6.5 / Phase 6)。 */
  mainLoop?: MainLoop;
  agentCtx?: AgentContext;
  llmProvider?: LLMProvider;
  /** 偏好学习调用使用的 LLM；未传则复用 llmProvider。 */
  preferenceLlmProvider?: LLMProvider;
  loadSettingsFn?: () => Settings;
  /**
   * W5: 完整工具列表 (含 MCP 外部工具)。不传则默认 BUILTIN_TOOLS。
   * 接入方 (server.ts) 用 ToolRegistry.list() 拼起来。
   */
  tools?: ToolDefinition[];
}

function makeEnvelope(
  type: UACSEnvelopeType,
  srcEnv: UACSEnvelope,
  payload: unknown,
  now: number,
): UACSEnvelope {
  return {
    id: newId('env'),
    type,
    sender: 'backend',
    recipient: srcEnv.sender,
    timestamp: now,
    correlationId: srcEnv.correlationId,
    traceMeta: srcEnv.traceMeta ?? {},
    payload: payload as any,
  };
}

export function toFriendlyMessage(c: ClassifiedError | { kind: string; message?: string }): string {
  switch (c.kind) {
    case 'auth':                    return '访问密钥无效，请到设置里检查';
    case 'rate_limit':              return '请求太频繁，请稍后再试';
    case 'context_overflow':        return '对话太长了，请新开一个话题';
    case 'network':                 return '连不上 AI 服务，请检查网络';
    case 'retryable':               return 'AI 服务暂时不可用，请稍后重试';
    case 'tool_not_found':          return '找不到这个工具';
    case 'tool_permission_denied':  return '这个操作需要你确认';
    case 'tool_timeout':            return '工具执行超时，试试加长 timeoutMs';
    case 'tool_sandbox_violation':  return '不允许访问这个目录';
    case 'tool_preview_failed':     return '工具参数有误，请换个说法';
    case 'tool_error':              return '工具执行失败，请换个说法';
    case 'file_too_large':          return '文件太大，请用 offset+limit 分段读';
    case 'quota_exceeded':          return 'AI 服务额度用完了';
    case 'skill_load_failed':       return '技能加载失败，可能是格式错误';
    case 'skill_already_installed': return '这个技能已经装过了';
    case 'unknown_command':         return '灵枢不懂这个命令，试试 /帮助';
    case 'session_expired':         return '会话过期了，请重新连接';
    case 'unknown':                 return '未知错误，请稍后再试';
    default:                        return '未知错误，请稍后再试';
  }
}

// ── Phase W2.4: 对话式技能创建状态机 (chat-trigger 模块) ────────────
// chat-handler 在每个 chat.request 最前面调用 chatTrigger 处理 wizard 流程.
// chatTrigger 自己持有 module-level session store, 由 chat-handler deps.llmProvider 注入 LLM.
// Test hook 转 re-export 兼容现有 chat-handler-skill.test.ts.
export function _clearWizardSessionsForTest(): void {
  _triggerClearWizardSessions();
}

export function _getWizardSessionForTest(wizardSessionId: string): WizardSession | undefined {
  return _triggerGetWizardSession(wizardSessionId);
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const now = deps.now ?? (() => Date.now());
  const loadSettingsFn = deps.loadSettingsFn ?? loadSettings;

  // ── Phase W2.4: 把对话式技能状态机委托给 chat-trigger 模块 ──
  // saveSkill 这里走一个本地轻量实现 (复用 routes.ts 落盘逻辑的等价物):
  // 把 preview 转成 SkillDefinition 写到 skills 目录,返回 path.
  const chatTrigger: ChatTrigger = createChatTrigger({
    emit: deps.emit,
    llm: deps.llmProvider,
    saveSkill: async (preview) => {
      // 延迟 import 避免循环 + 路径解析在 backend module-level 时正确.
      const { saveSkill: saveSkillStorage } = await import('../skills/storage.js');
      const skill = {
        name: preview.id.replace(/^skill-/, ''),
        displayName: preview.displayName,
        description: preview.displayDescription,
        version: '0.1.0',
        lingshuMinVersion: '0.1.0',
        triggers: preview.triggers,
        layer: preview.layer,
      };
      await saveSkillStorage(skill);
      return { path: `${preview.id}.json` };
    },
  });

  return async (env: UACSEnvelope): Promise<void> => {
    if (env.type !== 'chat.request') return;
    // Spec 1 H17: 用判别联合 narrow 替代 double cast
    if (!env.payload) return;
    const req = env.payload;
    const messageId = env.correlationId ?? `msg-${now()}`;
    const lastUserContent = extractLastUserContent(req.messages);

    // Learn from every normal user turn without blocking the response path.
    const learnPreference = async (assistantReply: string) => {
      if (deps.mainLoop && typeof deps.mainLoop.applyUserMessageForLearning === 'function') {
        await deps.mainLoop.applyUserMessageForLearning(lastUserContent, assistantReply);
      }
    };

    // ── Spec 2D: 内置命令路由 ("提醒我..." / "记住我喜欢...") ──────────
    // 检测到匹配命令 → 直接处理 (调用 reminder / preference service), 不走 LLM 流.
    // MainLoop 接入时 (deps.mainLoop 存在) 才启用; 不传走原路径.
    if (deps.mainLoop) {
      const cmd = matchBuiltInCommand(lastUserContent);
      if (cmd) {
        const reply = await executeBuiltInCommand(cmd, deps.mainLoop, env, messageId, req.sessionId, now());
        if (reply) {
          deps.emit(makeEnvelope('chat.delta', env, { messageId, delta: reply, sessionId: req.sessionId }, now()));
          deps.emit(makeEnvelope('chat.done', env, { messageId, finishReason: null, sessionId: req.sessionId }, now()));
          return;
        }
      }
    }

    // ── Phase W2.4: 对话式技能创建 (create_skill 意图 → wizard → acui.show) ──
    // 把 wizard 推进委托给 chatTrigger: 它检测意图,推进状态,emit ACUI 卡片.
    // 1) 已有 wizard → onAnswer 路径,emit acui.show / acui.hide
    // 2) 没 wizard, 命中 create_skill → 进入 wizard,emit acui.show
    // 3) 都没命中 → 走原 chat 流
    const currentSession = _triggerGetWizardByChatSession(req.sessionId);
    if (currentSession) {
      if (currentSession.phase === 'asking') {
        const currentQ = currentSession.questions[currentSession.currentIndex];
        await chatTrigger.onAnswer(currentSession.sessionId, currentQ.id, lastUserContent, env, req.sessionId);
        deps.emit(makeEnvelope('chat.done', env, {
          messageId,
          finishReason: 'tool',
          sessionId: req.sessionId,
        }, now()));
        return;
      }
      if (currentSession.phase === 'previewing') {
        // previewing 阶段用户消息 → "保存" 确认
        await chatTrigger.onAnswer(currentSession.sessionId, 'confirm-save', lastUserContent, env, req.sessionId);
        deps.emit(makeEnvelope('chat.done', env, {
          messageId,
          finishReason: 'tool',
          sessionId: req.sessionId,
        }, now()));
        return;
      }
      // saved / error 阶段 → 清理孤儿 mapping, 继续走原 chat 流
      if (currentSession.phase === 'saved' || currentSession.phase === 'error') {
        chatTrigger.cancelWizard(currentSession.sessionId);
      }
    }

    const wizard = await chatTrigger.maybeEnterWizard(lastUserContent, req.sessionId, env);
    if (wizard) {
      deps.emit(makeEnvelope('chat.done', env, {
        messageId,
        finishReason: 'tool',
        sessionId: req.sessionId,
      }, now()));
      return;
    }

    // ── Task 6.5 / Phase 6: runGoalMode 入口 ───────────────────────
    // userInput 含 "目标:" 且 settings.mode === 'goal' → 走 runGoalMode,
    // 跳过后续普通 chat / mock-tool 处理。runGoalMode 内部会广播
    // goal.started/iteration/complete/aborted AwarenessEvent, 这里只负责
    // 给前端补一个 chat.done 清掉 `sending` 状态。
    if (deps.mainLoop) {
      const settings = loadSettingsFn();
      if (lastUserContent.includes('目标:') && settings.mode === 'plan') {
        const goalCtx: AgentContext = deps.agentCtx ?? defaultAgentContext();
        const llm: LLMProvider = deps.llmProvider ?? defaultLlmProvider();
        await deps.mainLoop.runPlanMode(lastUserContent, goalCtx, llm);
        await learnPreference('');
        deps.emit(makeEnvelope('chat.done', env, {
          messageId, finishReason: 'tool', sessionId: req.sessionId,
        }, now()));
        return;
      }
      if (settings.mode === 'goal' && lastUserContent.includes('目标:')) {
        const goalCtx: AgentContext = deps.agentCtx ?? defaultAgentContext();
        const llm: LLMProvider = deps.llmProvider ?? defaultLlmProvider();
        await deps.mainLoop.runGoalMode(lastUserContent, goalCtx, llm);
        await learnPreference('');
        deps.emit(makeEnvelope('chat.done', env, {
          messageId,
          finishReason: 'tool',
          sessionId: req.sessionId,
        }, now()));
        return;
      }
    }

    const tryRun = async () => {
      // Mock tool loop (Spec 1 C1): gated by env flag, runs before provider stream.
      // Real LLM tool_use integration is deferred to Spec 2.
      if (isMockToolsEnabled()) {
        const parsed = parseMockToolFromMessage(lastUserContent);
        if (parsed) {
          await executeMockTool(parsed, deps, env, messageId, req.sessionId, now);
          return;
        }
      }

      const provider = deps.getProvider('chat');

      // Optional compression step: only if compressor is provided and shouldCompress=true
      if (deps.compressor && deps.compressor.shouldCompress(req.messages as any)) {
        try {
          req.messages = deps.compressor.compressWithMiddleEvict(req.messages as any);
        } catch (err) {
          if (err instanceof ContextOverflowError) {
            deps.emit(makeEnvelope('error', env, {
              code: 'context_overflow',
              message: '对话太长了，请新开一个话题',
              recoverable: false,
            }, now()));
            return;
          }
          throw err;
        }
      }

      await withWatchdog(async (signal) => {
        let assistantReply = '';
        for await (const chunk of provider.chatStream({ messages: req.messages, model: req.model })) {
          if (signal.aborted) break;
          if (chunk.delta) {
            assistantReply += chunk.delta;
            const deltaPayload: ChatDeltaPayload = { messageId, delta: chunk.delta, sessionId: req.sessionId };
            deps.emit(makeEnvelope('chat.delta', env, deltaPayload, now()));
          }
        }
        await learnPreference(assistantReply);
        const donePayload: ChatDonePayload = { messageId, finishReason: null, sessionId: req.sessionId };
        deps.emit(makeEnvelope('chat.done', env, donePayload, now()));
      }, { timeoutMs });
    };

    try {
      await tryRun();
    } catch (err) {
      if (err instanceof WatchdogTimeout) {
        deps.emit(makeEnvelope('error', env, {
          code: 'timeout',
          message: 'AI 响应超时，请重试',
          recoverable: true,
        }, now()));
        return;
      }
      const classified: ClassifiedError = isClassifiedError(err) ? err : classifyError(err, 'chat');
      deps.emit(makeEnvelope('error', env, {
        code: classified.kind,
        message: toFriendlyMessage(classified),
        recoverable: classified.kind === 'rate_limit' || classified.kind === 'network',
      }, now()));
    }
  };
}

// H4: 抽出 last user content, 消除 4 处重复 [...reverse].find 逻辑
function extractLastUserContent(messages: unknown[]): string {
  const last = [...messages].reverse().find((m: any) => m?.role === 'user');
  if (!last) return '';
  const c = (last as any).content;
  return typeof c === 'string' ? c : '';
}

function isClassifiedError(err: unknown): err is ClassifiedError {
  return !!err && typeof err === 'object' && 'kind' in (err as any) && typeof (err as any).kind === 'string';
}

// ── Mock tool loop (Spec 1 C1 minimal wiring) ───────────────────
// Gated by env flag LINGSHU_MOCK_TOOLS=1 so real LLM tool_use stays in Spec 2.
// Triggers: "跑 <cmd>" → run_command, "读 <path>" → read_file.
// Emits tool.preview → tool.output → tool.result envelopes.
// Returns true if a mock tool was executed, false if no keyword matched.
export function isMockToolsEnabled(): boolean {
  return process.env.LINGSHU_MOCK_TOOLS === '1';
}

interface ParsedMockTool {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  activityId: string;
}

export function parseMockToolFromMessage(
  lastUserContent: string,
  tools: ToolDefinition[] = BUILTIN_TOOLS,
): ParsedMockTool | null {
  const trimmed = lastUserContent.trim();
  // Pattern 1: 跑 <cmd> → run_command
  const runMatch = trimmed.match(/^跑\s+(.+)$/);
  if (runMatch) {
    const tool = tools.find((t) => t.name === 'run_command');
    if (tool) {
      return {
        tool,
        args: { command: runMatch[1].trim() },
        activityId: newId('activity'),
      };
    }
  }
  // Pattern 2: 读 <path> → read_file
  const readMatch = trimmed.match(/^读\s+(.+)$/);
  if (readMatch) {
    const tool = tools.find((t) => t.name === 'read_file');
    if (tool) {
      return {
        tool,
        args: { path: readMatch[1].trim() },
        activityId: newId('activity'),
      };
    }
  }
  return null;
}

// Phase C.4 — capability tools that are routed via UACS capability.invoke
// instead of local execute() (backend cannot require electron).
const CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set(['browser', 'map', 'media', 'skill']);

function isCapabilityTool(tool: ToolDefinition): boolean {
  return CAPABILITY_TOOL_NAMES.has(tool.name);
}

export async function executeMockTool(
  parsed: ParsedMockTool,
  deps: ChatHandlerDeps,
  env: UACSEnvelope,
  messageId: string,
  sessionId: string,
  now: () => number,
): Promise<void> {
  // ── V6 tool_call start envelope (AgentActivityCards) ────────────
  // 在所有原有 envelope 之前 emit, 给前端 AgentActivityCards 一个 start 钩子。
  // 这一步不替换 tool.preview — 老前端仍走 tool.preview, 新前端用 tool_call_*。
  const toolCallId = parsed.activityId;
  const toolCallStartedAt = now();
  const startEvt: ToolCallStartEvent = {
    type: 'tool_call_start',
    toolCallId,
    name: parsed.tool.name,
    displayName: parsed.tool.displayName,
    displayDescription: parsed.tool.displayDescription,
    args: parsed.args,
    risk: parsed.tool.risk,
    timestamp: toolCallStartedAt,
  };
  emitToolCall(startEvt);

  // 1. tool.preview
  const preview = buildToolPreview(parsed.tool, parsed.args);
  deps.emit(makeEnvelope('tool.preview', env, {
    toolName: preview.toolName,
    displayName: preview.displayName,
    displayDescription: preview.displayDescription,
    previewText: preview.previewText,
    args: preview.args,
  }, now()));

  // ── Task 6.5 / Phase 6: Permission Gate 接入 ───────────────────
  // Capability 工具 (browser/map/media/skill) 走 UACS capability.invoke
  // (前端有独立权限审批路径), 不走 backend gate.
  // 其他工具: 调 mainLoop.gateToolCall → allow/deny/ask(已 await 用户回应).
  if (deps.mainLoop && !isCapabilityTool(parsed.tool)) {
    const decision = await deps.mainLoop.gateToolCall(parsed.tool, parsed.args);
    if (decision.kind === 'deny') {
      // 拒绝 / 超时: 不执行工具, 返回友好提示给前端
      const friendly = denyReasonToFriendly(decision.reason);
      deps.emit(makeEnvelope('tool.output', env, {
        toolName: parsed.tool.name,
        chunk: friendly,
      }, now()));
      deps.emit(makeEnvelope('tool.result', env, {
        toolName: parsed.tool.name,
        ok: false,
        errorKind: 'tool_permission_denied',
        message: friendly,
      }, now()));
      // V6 tool_call result envelope (deny 路径)
      emitToolCall({
        type: 'tool_call_result',
        toolCallId,
        result: { ok: false, denied: true, message: friendly },
        durationMs: now() - toolCallStartedAt,
        status: 'error',
        errorMessage: friendly,
      });
      deps.emit(makeEnvelope('chat.done', env, {
        messageId,
        finishReason: 'tool',
        sessionId,
      }, now()));
      return;
    }
    // allow → fall through 到原 execute 路径
  }

  // 2. tool.output — execute the tool, format the result, emit as one chunk.
  // Phase C.4: capability tools (browser/map/media/skill) bypass local execute
  // and route through UACS capability.invoke envelope. The renderer picks
  // this up, calls the main-process pool, then sends back capability.result.
  let execResult: any;
  let execOk = true;
  let errorKind: string = 'tool_error';
  if (isCapabilityTool(parsed.tool)) {
    try {
      const invokeId = emitCapabilityInvoke({
        capability: parsed.tool.name as 'browser' | 'map' | 'media' | 'skill',
        args: parsed.args,
        source: env,
        emit: deps.emit,
      });
      execResult = await awaitCapabilityResult(invokeId);
      if (execResult && typeof execResult === 'object' && 'ok' in execResult) {
        execOk = Boolean(execResult.ok);
        if (!execOk) {
          errorKind = (execResult && typeof execResult === 'object' && 'errorKind' in execResult)
            ? String((execResult as any).errorKind)
            : 'capability_error';
        }
      }
    } catch (err) {
      // Spec 1: 失败路径先 console.error 留 raw 错误供排障
      console.error('[mock-tool] capability invoke failed:', err);
      execOk = false;
      errorKind = 'capability_error';
      execResult = { ok: false, error: String(err) };
    }
  } else {
    try {
      execResult = await parsed.tool.execute(parsed.args);
      if (execResult && typeof execResult === 'object' && 'ok' in execResult) {
        execOk = Boolean(execResult.ok);
        if (!execOk) {
          errorKind = (execResult && typeof execResult === 'object' && 'errorKind' in execResult)
            ? String((execResult as any).errorKind)
            : 'tool_error';
        }
      }
    } catch (err) {
      // Spec 1: 失败路径先 console.error 留 raw 错误供排障
      console.error('[mock-tool] execution failed:', err);
      execOk = false;
      // 优先识别 sandbox 越界, 不要 fallback 到通用 tool_error
      const errMsg = String(err);
      if (/outside\s*(sandbox|project\s*root)/i.test(errMsg) || /outside sandbox/i.test(errMsg)) {
        errorKind = 'tool_sandbox_violation';
      } else {
        errorKind = 'tool_error';
      }
      execResult = { ok: false, error: errMsg };
    }
  }

  const outputText = formatToolOutput(parsed.tool.name, execResult);
  // 失败时再次覆盖:输出走中文友好版本(不泄露原始 c.message 全文)
  const friendlyOutput = execOk
    ? outputText
    : `错误：${outputText.replace(/^错误[:：]?\s*/, '')}`;
  deps.emit(makeEnvelope('tool.output', env, {
    toolName: parsed.tool.name,
    chunk: execOk ? outputText : friendlyOutput,
  }, now()));

  // 3. tool.result
  if (execOk) {
    deps.emit(makeEnvelope('tool.result', env, {
      toolName: parsed.tool.name,
      ok: true,
      message: outputText,
    }, now()));
  } else {
    deps.emit(makeEnvelope('tool.result', env, {
      toolName: parsed.tool.name,
      ok: false,
      errorKind,
      message: friendlyOutput,
    }, now()));
  }

  // ── V6 tool_call result envelope (AgentActivityCards) ───────────
  // 跟 tool.result envelope 并行 emit, 不替换老 envelope。前端新组件用
  // tool_call_* 拼成一张卡; 老组件继续用 tool.preview/output/result。
  const resultEvt: ToolCallResultEvent = {
    type: 'tool_call_result',
    toolCallId,
    result: execResult ?? null,
    durationMs: now() - toolCallStartedAt,
    status: execOk ? 'success' : 'error',
    errorMessage: execOk ? undefined : (errorKind ? toFriendlyMessage({ kind: errorKind } as any) || friendlyOutput : friendlyOutput),
  };
  emitToolCall(resultEvt);

  // 4. chat.done — let the renderer clear `sending` state even when the mock
  // tool loop short-circuits the provider stream.
  const donePayload: ChatDonePayload = { messageId, finishReason: 'tool', sessionId };
  deps.emit(makeEnvelope('chat.done', env, donePayload, now()));
}

function formatToolOutput(toolName: string, result: any): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  // Spec 1 + Phase A.6: 失败时不泄露 raw path / raw error 全文, 仅保留友好提示
  if (result.ok === false) {
    const errMsg = String(result.error ?? '');
    if (/outside\s*(sandbox|project\s*root)/i.test(errMsg)) {
      return '不允许访问这个目录';
    }
    return `错误: ${errMsg.replace(/^错误[:：]?\s*/, '')}`;
  }
  if (toolName === 'run_command') {
    return `${result.stdout ?? ''}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`.trim();
  }
  if (toolName === 'read_file') {
    return String(result.content ?? '');
  }
  if (toolName === 'list_files') {
    if (!Array.isArray(result.files)) return '';
    return result.files.map((f: any) => `${f.type === 'dir' ? '[D]' : '[F]'} ${f.name}`).join('\n');
  }
  if (toolName === 'web_search') {
    if (!Array.isArray(result.results)) return '';
    return result.results.map((r: any) => `- ${r.title}: ${r.url}`).join('\n');
  }
  return JSON.stringify(result);
}

// ── Task 6.5: Permission Gate deny / timeout 友好化 ─────────────
// Spec 1 中文 UX: 不暴露 raw permission gate reason 全文, 转换为短句。
function denyReasonToFriendly(reason: string): string {
  if (/timeout/i.test(reason)) return '这个操作需要你确认（已超时）';
  if (/Denied by user/i.test(reason)) return '这个操作需要你确认';
  // 规则拒绝等其它情况: 给一个简短通用提示
  return '这个操作需要你确认';
}

// ── Spec 2D: 内置命令路由 ("提醒我..." / "记住...") ──────────────────
// borrow Hermes "command prefix" 模式 (Hermes 把 / 开头的命令从自然语言分开)
// + Apple Reminders "set reminder" NL.
type BuiltInCommand =
  | { kind: 'reminder'; text: string }
  | { kind: 'preference'; key: string; value: string; text: string };

function matchBuiltInCommand(text: string): BuiltInCommand | null {
  const t = text.trim();
  const REMINDER_TRIGGER = /(?:提醒|remind)\s+(?:我|me)|明天|今天|\d+\s*点/i;
  // 1. 提醒我 / 提醒 (中文)
  if (REMINDER_TRIGGER.test(t)) {
    return { kind: 'reminder', text: t };
  }
  // 2. 记住 / remember (key=value pattern: "记住我喜欢智能审核" / "记住 theme=dark")
  const rememberMatch = t.match(/^(?:记住|remember|记住:)\s*(.+)$/i);
  if (rememberMatch) {
    const body = rememberMatch[1].trim();
    // 尝试解析 "key=value" 形式
    const kvMatch = body.match(/^([\w_]+)\s*[:=]\s*(.+)$/);
    if (kvMatch) {
      return { kind: 'preference', key: kvMatch[1].trim(), value: kvMatch[2].trim(), text: t };
    }
    // 简单 "记住我喜欢 X" 形式 → 存为 preference_text
    return { kind: 'preference', key: 'user_note', value: body, text: t };
  }
  return null;
}

async function executeBuiltInCommand(
  cmd: BuiltInCommand,
  mainLoop: NonNullable<ChatHandlerDeps['mainLoop']>,
  env: UACSEnvelope,
  messageId: string,
  sessionId: string,
  now: number,
): Promise<string | null> {
  if (cmd.kind === 'reminder') {
    const reminderSvc = mainLoop.getReminderService();
    const reminder = reminderSvc.addFromText(cmd.text, now);
    if (reminder) {
      const when = new Date(reminder.triggerAt).toLocaleString('zh-CN');
      return `好的, 我已设置提醒 (${when}) 提醒 ${reminder.message}。`;
    }
    return '我没听懂时间, 试试 "明天 9 点提醒我开会" 这种格式。';
  }

  if (cmd.kind === 'preference') {
    mainLoop.applyExplicitPreference(cmd.key, cmd.value);
    return `好的, 我已记住 (${cmd.key} = ${cmd.value})。`;
  }

  return null;
}

// ── Task 6.5: 默认 AgentContext / LLMProvider stub ──────────────
// Phase 6 后续会用真实实现替换; 现在 chat-handler 不能依赖 main-loop 自己造。
// 这些 stub 让 deps 不传 agentCtx / llmProvider 时 runGoalMode 不会崩。
function defaultAgentContext(): AgentContext {
  return {
    runOnce: async () => 'stub context summary',
    isAborted: () => false,
    askUserContinue: async () => undefined,
  };
}

function defaultLlmProvider(): LLMProvider {
  // Spec 2A I4 — stub must throw, not fake-pass with results:[].
  // Borrowed from CrewAI agent error handling: surface the missing-config
  // error loudly so the caller (goal loop) knows no real LLM is wired.
  // Previously this returned '{ "results": [] }' which silently made
  // allPassed() always false (or worse, vacuously true with empty acceptance),
  // causing goal loops to either spin forever or fake-complete.
  return {
    complete: async () => {
      throw new Error(
        'No LLM provider configured. Set LINGSHU_DEEPSEEK_API_KEY or wire deps.llmProvider before using goal mode.',
      );
    },
  };
}

// ── Phase W2.4: SkillWizardCard props helper 现在由 chat-trigger 模块负责 ──
// (extracted to chat-trigger.ts → buildAcuiPropsFromWizard)
