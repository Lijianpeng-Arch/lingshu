/**
 * ContextCompressor — 5 策略压缩 + middle-eviction
 *
 * 设计目的:长对话塞不进模型上下文时,按策略裁剪或中间驱逐。
 * 估算 token 用 4 字符/token(英文经验值;中文偏密但简单起见用同一公式)。
 */

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export enum CompressType {
  NO_COMPRESS = 'no_compress',
  POST_CUT_BY_MSG = 'post_cut_by_msg',
  POST_CUT_BY_TOKEN = 'post_cut_by_token',
  PRE_CUT_BY_MSG = 'pre_cut_by_msg',
  PRE_CUT_BY_TOKEN = 'pre_cut_by_token',
}

export interface CompressOptions {
  keepMsgCount?: number;
  tokenBudget?: number;
}

const DEFAULT_KEEP_MSG = 20;
const DEFAULT_TOKEN_BUDGET = 4000;
/** 容忍倍数:低于此倍数视为压缩成功,超过则可能还要 middle-evict 或抛错 */
const OVERFLOW_TOLERANCE = 1.1;
/** 3 次压缩仍 overflow 的循环上限 */
const MAX_COMPRESS_PASSES = 3;

export class ContextOverflowError extends Error {
  readonly code = 'context_overflow' as const;
  constructor(message = 'Context overflow: messages exceed budget even after compression') {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

/**
 * 中间驱逐:保留 system + 头 N 条 + 尾 N 条,中间替换为 NOTE。
 */
export function middleEvict(messages: Message[], keepHead = 2, keepTail = 4): Message[] {
  const sys = messages.find((m) => m.role === 'system');
  const nonSys = messages.filter((m) => m.role !== 'system');

  if (nonSys.length <= keepHead + keepTail) {
    // 不够切,原样返回(去掉可能有重复的 system 元素?这里保留第一条)
    return messages;
  }

  const head = nonSys.slice(0, keepHead);
  const tail = nonSys.slice(nonSys.length - keepTail);
  const removed = nonSys.length - keepHead - keepTail;

  const note: Message = {
    role: 'system',
    content: `<NOTE>Middle evicted: removed ${removed} messages to fit context budget. Key earlier context may be lost. Summarize if needed.</NOTE>`,
  };

  return [...(sys ? [sys] : []), ...head, note, ...tail];
}

export class ContextCompressor {
  private readonly keepMsgCount: number;
  private readonly tokenBudget: number;

  constructor(opts?: Partial<CompressOptions>) {
    this.keepMsgCount = opts?.keepMsgCount ?? DEFAULT_KEEP_MSG;
    this.tokenBudget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  }

  /** 粗估:4 字符 = 1 token(向上取整) */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  countTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      // 给每条消息加 4 token 的结构开销(role + 分隔)
      total += 4 + this.estimateTokens(m.content);
    }
    return total;
  }

  /**
   * 是否需要压缩:总 token 数 ≥ tokenBudget * threshold。
   * 默认 threshold=0.5,即用量过半就触发。
   */
  shouldCompress(messages: Message[], threshold = 0.5): boolean {
    const total = this.countTokens(messages);
    return total >= this.tokenBudget * threshold;
  }

  /**
   * 按策略压缩消息。
   * 如果一次压缩后仍超 budget * OVERFLOW_TOLERANCE,会再压一轮;最多 MAX_COMPRESS_PASSES 轮。
   * 仍超则抛 ContextOverflowError。
   */
  compressMessages(
    messages: Message[],
    type: CompressType = CompressType.POST_CUT_BY_TOKEN,
    options?: CompressOptions,
  ): Message[] {
    const opts = { keepMsgCount: this.keepMsgCount, tokenBudget: this.tokenBudget, ...options };

    if (type === CompressType.NO_COMPRESS) {
      return [...messages];
    }

    let current: Message[] = this.applyStrategy(messages, type, opts);

    // POST/PRE_CUT_BY_TOKEN 之外的策略,只要符合预期长度就不做多轮
    if (
      type !== CompressType.POST_CUT_BY_TOKEN &&
      type !== CompressType.PRE_CUT_BY_TOKEN
    ) {
      return current;
    }

    // 多轮压缩:每次压缩后检查剩余预算,如仍超就再压一轮(再砍 50%)
    for (let pass = 1; pass < MAX_COMPRESS_PASSES; pass++) {
      const tokens = this.countTokens(current);
      if (tokens <= opts.tokenBudget * OVERFLOW_TOLERANCE) {
        return current;
      }
      // 再砍:把 keepMsgCount / tokenBudget 各砍一半
      const tighter: CompressOptions = {
        keepMsgCount: Math.max(2, Math.floor(opts.keepMsgCount / 2)),
        tokenBudget: Math.max(100, Math.floor(opts.tokenBudget * 0.5)),
      };
      current = this.applyStrategy(current, type, tighter);
    }

    // 3 轮后仍 overflow → 抛错
    if (this.countTokens(current) > opts.tokenBudget * OVERFLOW_TOLERANCE) {
      throw new ContextOverflowError();
    }

    return current;
  }

  /**
   * 链式策略:先 POST_CUT_BY_TOKEN 砍到预算,仍不够再 middle-evict。
   * 砍到 token 预算内后直接返回;不抛错(middle-evict 永远能产生一个更小的结果)。
   */
  compressWithMiddleEvict(messages: Message[], options?: CompressOptions): Message[] {
    const opts = { keepMsgCount: this.keepMsgCount, tokenBudget: this.tokenBudget, ...options };
    let current = this.applyStrategy(messages, CompressType.POST_CUT_BY_TOKEN, opts);

    if (this.countTokens(current) <= opts.tokenBudget * OVERFLOW_TOLERANCE) {
      return current;
    }

    // 不够再 middle-evict:系统消息 + 头 2 + 尾 4
    return middleEvict(current, 2, 4);
  }

  // ---------------- private ----------------

  private applyStrategy(
    messages: Message[],
    type: CompressType,
    opts: CompressOptions,
  ): Message[] {
    const sys = messages.find((m) => m.role === 'system');
    const nonSys = messages.filter((m) => m.role !== 'system');
    const keepMsg = opts.keepMsgCount ?? DEFAULT_KEEP_MSG;
    const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const sysArr = sys ? [sys] : [];

    switch (type) {
      case CompressType.POST_CUT_BY_MSG:
        return [...sysArr, ...nonSys.slice(-keepMsg)];

      case CompressType.POST_CUT_BY_TOKEN: {
        const out: Message[] = [...sysArr];
        let used = sys ? 4 + this.estimateTokens(sys.content) : 0;
        // 从后往前累加
        for (let i = nonSys.length - 1; i >= 0; i--) {
          const cost = 4 + this.estimateTokens(nonSys[i].content);
          if (used + cost > budget && out.length > sysArr.length) break;
          used += cost;
          out.splice(sysArr.length, 0, nonSys[i]); // 插到 sys 后,保持顺序
        }
        return out;
      }

      case CompressType.PRE_CUT_BY_MSG:
        return [...sysArr, ...nonSys.slice(0, keepMsg)];

      case CompressType.PRE_CUT_BY_TOKEN: {
        const out: Message[] = [...sysArr];
        let used = sys ? 4 + this.estimateTokens(sys.content) : 0;
        for (const m of nonSys) {
          const cost = 4 + this.estimateTokens(m.content);
          if (used + cost > budget && out.length > sysArr.length) break;
          used += cost;
          out.push(m);
        }
        return out;
      }

      case CompressType.NO_COMPRESS:
      default:
        return [...messages];
    }
  }
}
