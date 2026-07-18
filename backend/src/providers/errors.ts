/**
 * Provider 失败分类器
 *
 * 设计来源：Agno `fallback.py` (FailureClass-aware fallback)
 * 不变式：Auth 错误**永远**不能 fallback（避免用户填错 key 时被默默掩盖）
 */

import type { ClassifiedError } from './types.js';

// 中文 + 英文 provider 都覆盖
const CONTEXT_WINDOW_PATTERNS: readonly string[] = [
  'context_length_exceeded',
  'context window',
  'maximum context length',
  'token limit',
  'max_tokens',
  'too many tokens',
  'payload too large',
  'content_too_large',
  'request too large',
  'input too long',
  'prompt is too long',
  'prompt too long',
  'exceeds the model',
  '上下文超限',
  '上下文长度超过',
  '输入过长',
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /unauthoriz/i,
  /invalid.*api.*key/i,
  /authentication/i,
  /api key not valid/i,
  /incorrect api key/i,
  /key.*expired/i,
  /身份验证失败/,
  /无效的.*密钥/,
  /密钥错误/,
];

const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
]);

export function classifyError(err: unknown, providerName: string): ClassifiedError {
  const anyErr = err as any;
  const status: number | undefined = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status;
  const code: string | undefined = anyErr?.code ?? anyErr?.cause?.code;
  const rawMessage = anyErr?.message ?? err;
  const message = String(rawMessage ?? '');
  const lower = message.toLowerCase();

  // 1. Network（无 HTTP 响应）
  if ((code && NETWORK_CODES.has(code)) || err instanceof TypeError) {
    return { kind: 'network', message: `Network error: ${message}` };
  }

  // 2. Auth（401/403 + 模式匹配）—— Agno 不变式：永远不被 fallback 掩盖
  if (status === 401 || status === 403 || AUTH_PATTERNS.some((r) => r.test(message))) {
    return {
      kind: 'auth',
      message: `Authentication failed for ${providerName}: ${message}`,
      statusCode: status,
    };
  }

  // 3. Rate limit（429 + 529 Anthropic overload）
  if (status === 429 || status === 529 || /rate.?limit/i.test(lower)) {
    const retryAfterSec = parseRetryAfter(anyErr?.headers);
    return {
      kind: 'rate_limit',
      message: `Rate limited: ${message}`,
      retryAfterSec,
    };
  }

  // 4. Context overflow（模式匹配）
  if (CONTEXT_WINDOW_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'context_overflow', message: `Context overflow: ${message}` };
  }

  // 5. Retryable（5xx，非 501）
  if (status && status >= 500 && status !== 501) {
    return {
      kind: 'retryable',
      message: `Server error ${status}: ${message}`,
      statusCode: status,
    };
  }

  // 6. Unknown
  return {
    kind: 'unknown',
    message: `${providerName} error: ${message}`,
    statusCode: status,
  };
}

function parseRetryAfter(h: Record<string, string> | undefined): number | undefined {
  if (!h) return undefined;
  const v = h['retry-after'] ?? h['Retry-After'] ?? h['x-ratelimit-reset'];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
