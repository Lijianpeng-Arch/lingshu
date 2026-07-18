import { z } from 'zod';

export const EndpointSchema = z.enum(['electron', 'backend', 'soul', 'tool']);
export type Endpoint = z.infer<typeof EndpointSchema>;

export const AcuiHintSchema = z.object({
  placement: z.enum(['notification', 'center', 'floating', 'stage']).optional(),
  size: z.union([
    z.enum(['sm', 'md', 'lg', 'xl']),
    z.object({ w: z.union([z.number(), z.string()]), h: z.union([z.number(), z.string()]) }),
  ]).optional(),
  draggable: z.boolean().optional(),
  modal: z.boolean().optional(),
  enter: z.string().optional(),
  exit: z.string().optional(),
});
export type AcuiHint = z.infer<typeof AcuiHintSchema>;

export const AcuiShowPayloadSchema = z.object({
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  hint: AcuiHintSchema.optional(),
});
export type AcuiShowPayload = z.infer<typeof AcuiShowPayloadSchema>;

export const AcuiHidePayloadSchema = z.object({
  componentId: z.string().min(1),
});
export type AcuiHidePayload = z.infer<typeof AcuiHidePayloadSchema>;

export const ChatMessageInputSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessageInput = z.infer<typeof ChatMessageInputSchema>;

export const ChatRequestPayloadSchema = z.object({
  messages: z.array(ChatMessageInputSchema).min(1),
  sessionId: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type ChatRequestPayload = z.infer<typeof ChatRequestPayloadSchema>;

export const ChatResponsePayloadSchema = z.object({
  messageId: z.string().min(1),
  content: z.string(),
  done: z.boolean(),
  sessionId: z.string().optional(),
});
export type ChatResponsePayload = z.infer<typeof ChatResponsePayloadSchema>;

export const ChatDeltaPayloadSchema = z.object({
  messageId: z.string().min(1),
  delta: z.string(),
  sessionId: z.string().optional(),
});
export type ChatDeltaPayload = z.infer<typeof ChatDeltaPayloadSchema>;

export const ChatDonePayloadSchema = z.object({
  messageId: z.string().min(1),
  finishReason: z.string().nullable().optional(),
  sessionId: z.string().optional(),
});
export type ChatDonePayload = z.infer<typeof ChatDonePayloadSchema>;

export const ProbeRequestPayloadSchema = z.object({
  providerName: z.string().min(1),
  apiKey: z.string().min(1),
  baseURL: z.string().url().optional(),
  model: z.string().optional(),
});
export type ProbeRequestPayload = z.infer<typeof ProbeRequestPayloadSchema>;

export const ProbeResponsePayloadSchema = z.object({
  providerName: z.string().min(1),
  ok: z.boolean(),
  capabilities: z.array(z.string()).optional(),
  model: z.string().optional(),
  latencyMs: z.number().optional(),
  errorKind: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ProbeResponsePayload = z.infer<typeof ProbeResponsePayloadSchema>;

// Phase A.1 — window.* envelopes
export const WindowPresetSchema = z.enum(['developer', 'analyst', 'writer', 'focus']);
export type WindowPreset = z.infer<typeof WindowPresetSchema>;

export const WindowCreatePayloadSchema = z.object({
  kind: z.enum(['main', 'floating', 'detail', 'notify']),
  url: z.string().optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  title: z.string().optional(),
  /** Phase W4: preset hint — when set, handler auto-creates windows from preset layout */
  preset: WindowPresetSchema.optional(),
  /** Phase W4: require user confirm before opening (default true for non-main kinds) */
  requireConfirm: z.boolean().optional(),
});
export type WindowCreatePayload = z.infer<typeof WindowCreatePayloadSchema>;

export const WindowClosePayloadSchema = z.object({
  id: z.string().min(1),
});
export type WindowClosePayload = z.infer<typeof WindowClosePayloadSchema>;

export const WindowFocusPayloadSchema = z.object({
  id: z.string().min(1),
});
export type WindowFocusPayload = z.infer<typeof WindowFocusPayloadSchema>;

export const WindowResizePayloadSchema = z.object({
  id: z.string().min(1),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type WindowResizePayload = z.infer<typeof WindowResizePayloadSchema>;

export const WindowMessagePayloadSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  message: z.unknown(),
});
export type WindowMessagePayload = z.infer<typeof WindowMessagePayloadSchema>;

export const WindowPresetPayloadSchema = z.object({
  preset: WindowPresetSchema,
});
export type WindowPresetPayload = z.infer<typeof WindowPresetPayloadSchema>;

// Phase A.1 — capability.* envelopes
export const CapabilityInvokePayloadSchema = z.object({
  capability: z.enum(['browser', 'map', 'media', 'skill']),
  args: z.record(z.string(), z.unknown()),
  /** Phase W4 v2 fields — all optional, defaults preserve v1 behavior */
  version: z.literal(2).optional(),
  /** IPC call timeout in ms (default 60_000) */
  timeoutMs: z.number().int().positive().optional(),
  /** Priority lane (default 'normal') — informs renderer/scheduler ordering */
  priority: z.enum(['low', 'normal', 'high']).optional(),
  /** Fallback capability name to try on failure (must also be whitelisted) */
  fallback: z.enum(['browser', 'map', 'media', 'skill']).optional(),
  /** Optional preload script path to inject before invoke (used for ad-hoc skills) */
  preload: z.string().optional(),
});
export type CapabilityInvokePayload = z.infer<typeof CapabilityInvokePayloadSchema>;

export const CapabilityResultPayloadSchema = z.object({
  capability: z.string().min(1),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type CapabilityResultPayload = z.infer<typeof CapabilityResultPayloadSchema>;

// Phase A.1 — awareness.* envelopes
export const TaskInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'running', 'done', 'failed']),
});
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

export const ThoughtInfoSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
});
export type ThoughtInfo = z.infer<typeof ThoughtInfoSchema>;

export const SystemStatusSchema = z.object({
  mode: z.string(),
  uptime: z.number().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const AwarenessUpdatePayloadSchema = z.object({
  kind: z.enum(['task', 'thought', 'status', 'emotion', 'reflection']),
  data: z.unknown(),
});
export type AwarenessUpdatePayload = z.infer<typeof AwarenessUpdatePayloadSchema>;

export const AwarenessSnapshotPayloadSchema = z.object({
  tasks: z.array(TaskInfoSchema),
  thoughts: z.array(ThoughtInfoSchema),
  status: SystemStatusSchema,
  emotion: z.string(),
});
export type AwarenessSnapshotPayload = z.infer<typeof AwarenessSnapshotPayloadSchema>;

export const ErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const TraceMetaSchema = z.object({
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  userAction: z.string().optional(),
});
export type TraceMeta = z.infer<typeof TraceMetaSchema>;

export const UACSEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('acui.show'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: AcuiShowPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('acui.hide'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: AcuiHidePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('chat.request'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ChatRequestPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('chat.response'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ChatResponsePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('chat.delta'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ChatDeltaPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('chat.done'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ChatDonePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('probe.request'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ProbeRequestPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('probe.response'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ProbeResponsePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('error'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: ErrorPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('tool.preview'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: z.object({ toolName: z.string(), displayName: z.string(), displayDescription: z.string(), previewText: z.string(), args: z.record(z.string(), z.unknown()) }).optional() }),
  z.object({ id: z.string().min(1), type: z.literal('tool.output'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: z.object({ toolName: z.string(), chunk: z.string() }).optional() }),
  z.object({ id: z.string().min(1), type: z.literal('tool.result'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: z.object({ toolName: z.string(), ok: z.boolean(), message: z.string().optional(), errorKind: z.string().optional() }).optional() }),
  // Phase A.1 — window.* envelopes
  z.object({ id: z.string().min(1), type: z.literal('window.create'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowCreatePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('window.close'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowClosePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('window.focus'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowFocusPayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('window.resize'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowResizePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('window.message'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowMessagePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('window.preset'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: WindowPresetPayloadSchema.optional() }),
  // Phase A.1 — capability.* envelopes
  z.object({ id: z.string().min(1), type: z.literal('capability.invoke'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: CapabilityInvokePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('capability.result'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: CapabilityResultPayloadSchema.optional() }),
  // Phase A.1 — awareness.* envelopes
  z.object({ id: z.string().min(1), type: z.literal('awareness.update'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: AwarenessUpdatePayloadSchema.optional() }),
  z.object({ id: z.string().min(1), type: z.literal('awareness.snapshot'), sender: EndpointSchema, recipient: EndpointSchema, timestamp: z.number().int().positive(), correlationId: z.string().nullable(), traceMeta: TraceMetaSchema, payload: AwarenessSnapshotPayloadSchema.optional() }),
]);
export type UACSEnvelope = z.infer<typeof UACSEnvelopeSchema>;
export type UACSEnvelopeType = UACSEnvelope['type'];
