import { describe, it, expect } from 'vitest';
import { classifyError } from './errors.js';

describe('classifyError — auth', () => {
  it('classifies 401 as auth', () => {
    const e = Object.assign(new Error('Unauthorized'), { status: 401 });
    const result = classifyError(e, 'deepseek');
    expect(result.kind).toBe('auth');
    if (result.kind === 'auth') {
      expect(result.statusCode).toBe(401);
    }
  });

  it('classifies 403 as auth', () => {
    const e = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(classifyError(e, 'deepseek').kind).toBe('auth');
  });

  it('classifies pattern-matched Chinese auth error', () => {
    const e = new Error('身份验证失败：密钥错误');
    expect(classifyError(e, 'zhipu').kind).toBe('auth');
  });
});

describe('classifyError — rate_limit', () => {
  it('classifies 429 as rate_limit', () => {
    const e = Object.assign(new Error('Too many requests'), { status: 429 });
    const result = classifyError(e, 'deepseek');
    expect(result.kind).toBe('rate_limit');
  });

  it('classifies 529 (Anthropic overload) as rate_limit', () => {
    const e = Object.assign(new Error('Overloaded'), { status: 529 });
    expect(classifyError(e, 'anthropic').kind).toBe('rate_limit');
  });

  it('extracts retryAfter from headers', () => {
    const e = Object.assign(new Error('Rate limited'), {
      status: 429,
      headers: { 'retry-after': '60' },
    });
    const result = classifyError(e, 'deepseek');
    if (result.kind === 'rate_limit') {
      expect(result.retryAfterSec).toBe(60);
    }
  });
});

describe('classifyError — context_overflow', () => {
  it('classifies context_length_exceeded', () => {
    expect(
      classifyError(new Error('context_length_exceeded'), 'gpt').kind
    ).toBe('context_overflow');
  });

  it('classifies Chinese context overflow', () => {
    expect(classifyError(new Error('上下文超限'), 'zhipu').kind).toBe('context_overflow');
  });
});

describe('classifyError — network', () => {
  it('classifies ECONNREFUSED', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyError(e, 'deepseek').kind).toBe('network');
  });

  it('classifies ENOTFOUND', () => {
    const e = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(classifyError(e, 'deepseek').kind).toBe('network');
  });
});

describe('classifyError — retryable', () => {
  it('classifies 503 as retryable', () => {
    const e = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(classifyError(e, 'deepseek').kind).toBe('retryable');
  });

  it('classifies 500 as retryable', () => {
    const e = Object.assign(new Error('Internal Server Error'), { status: 500 });
    expect(classifyError(e, 'deepseek').kind).toBe('retryable');
  });

  it('does NOT classify 501 as retryable', () => {
    const e = Object.assign(new Error('Not Implemented'), { status: 501 });
    expect(classifyError(e, 'deepseek').kind).toBe('unknown');
  });
});

describe('classifyError — Agno invariant', () => {
  it('Auth error is NEVER classified as retryable (Agno 不变式)', () => {
    const e = Object.assign(new Error('Auth failed'), { status: 401 });
    const result = classifyError(e, 'deepseek');
    expect(result.kind).not.toBe('retryable');
    expect(result.kind).toBe('auth');
  });
});

describe('classifyError — unknown', () => {
  it('returns unknown for unrecognized errors', () => {
    const e = new Error('something weird');
    expect(classifyError(e, 'deepseek').kind).toBe('unknown');
  });

  it('handles null/undefined safely', () => {
    expect(classifyError(null, 'deepseek').kind).toBe('unknown');
    expect(classifyError(undefined, 'deepseek').kind).toBe('unknown');
  });
});
