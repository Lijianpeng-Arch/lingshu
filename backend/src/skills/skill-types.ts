/**
 * Skill Type Classifier (Phase W2.2)
 *
 * 三层技能判定:
 *   - prompt: 纯提示词模板(总结/翻译/改写)
 *   - api:    调外部 API(查天气/GitHub/翻译服务)
 *   - mcp:    通过 MCP 协议接入(本地文件/数据库)— 识别返回 mcp,完整支持留 Phase E
 *
 * 借鉴 Open Interpreter: ask-then-build 之前先识别技能类型,用对应模板。
 */

export type SkillLayer = 'prompt' | 'api' | 'mcp';

export interface SkillTypeResult {
  layer: SkillLayer;
  reason: string;
}

const PROMPT_KEYWORDS = ['总结', '摘要', '翻译', '改写', '润色', '解释', '分析', '提取', '生成', '写', '撰写', '建议'];
const API_KEYWORDS = ['查询', '查', '搜索', '获取', '拉取', '天气', 'GitHub', '新闻', '股票', '汇率', '翻译服务', 'API'];
const MCP_KEYWORDS = ['MCP', '本地文件', '本地数据库', '本地搜索'];

export function classifySkillType(subject: string): SkillTypeResult {
  const s = subject.toLowerCase();

  if (MCP_KEYWORDS.some(kw => s.includes(kw.toLowerCase()))) {
    return { layer: 'mcp', reason: '检测到 MCP 协议关键词(暂按 api 处理,Phase E 完整支持)' };
  }

  if (API_KEYWORDS.some(kw => s.includes(kw.toLowerCase()))) {
    return { layer: 'api', reason: '检测到外部数据源关键词' };
  }

  if (PROMPT_KEYWORDS.some(kw => s.includes(kw.toLowerCase()))) {
    return { layer: 'prompt', reason: '检测到内容处理关键词' };
  }

  // 兜底: 默认 prompt(用户最容易做)
  return { layer: 'prompt', reason: '默认按提示词模板处理(可后续调整)' };
}
