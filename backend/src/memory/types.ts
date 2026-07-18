import { z } from 'zod';

export type MemoryScope = 'short' | 'long' | 'profile' | 'task' | 'media';

export interface Memory {
  id: string;
  scope: MemoryScope;
  key?: string;        // long_term_memory 用 (e.g. 'user.name')
  content: string;     // 文本或 JSON.stringify()
  tags: string[];      // ['user:profile', 'skill:active']
  importance: number;  // 0-1, idle 整理用
  accessCount: number; // 被读取次数 (idle 升级用)
  lastAccessedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ThoughtKind = 'observation' | 'inference' | 'plan' | 'question' | 'decision' | 'reflection';

export interface Thought {
  id: string;
  parentId?: string;
  kind: ThoughtKind;
  content: string;
  confidence: number;  // 0-1
  createdAt: number;
}

export type TaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  parentId?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export type ReminderStatus = 'pending' | 'fired' | 'dismissed';

export interface Reminder {
  id: string;
  title: string;
  content?: string;
  triggerAt: number;
  status: ReminderStatus;
  relatedTaskId?: string;
  createdAt: number;
  firedAt?: number;
}

// Zod schemas for UACS envelope validation (Phase B 后续可能用)
export const MemoryScopeSchema = z.enum(['short', 'long', 'profile', 'task', 'media']);
export const ThoughtKindSchema = z.enum(['observation', 'inference', 'plan', 'question', 'decision', 'reflection']);
export const TaskStatusSchema = z.enum(['pending', 'active', 'done', 'failed', 'cancelled']);
export const ReminderStatusSchema = z.enum(['pending', 'fired', 'dismissed']);