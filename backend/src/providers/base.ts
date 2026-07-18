/**
 * OpenAICompatibleBase — OpenAI 兼容 Provider 基类
 *
 * 提供 HTTP 助手 + fetch 封装，子类只需要关心自己的特殊逻辑
 */

import type { ProviderConfig } from './types.js';

export abstract class OpenAICompatibleBase {
  protected readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** 通用 HTTP POST 助手（用于非 OpenAI SDK 场景） */
  protected async request<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.config.baseURL}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.extraHeaders,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    // I22: try/catch around json() — 网络/解析错误应带 status 抛出
    try {
      return (await res.json()) as T;
    } catch (parseErr) {
      const snippet = await res.text().catch(() => '');
      const err = new Error(
        `HTTP ${res.status}: failed to parse JSON response (${String(parseErr)}): ${snippet.slice(0, 500)}`
      ) as Error & { status?: number; cause?: unknown };
      err.status = res.status;
      err.cause = parseErr;
      throw err;
    }
  }
}
