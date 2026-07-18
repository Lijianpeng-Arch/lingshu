export type RiskLevel = 'low' | 'medium' | 'high';
export type Mode = 'autonomous' | 'goal' | 'smart' | 'step' | 'plan';
export type Action = 'allow' | 'deny' | 'ask';

export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

export interface ToolDescriptor {
  name: string;
  displayName: string;
  displayDescription: string;
  risk: RiskLevel;
}

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  mode: Mode;
  rules: Rule[];
  toolDescriptor: ToolDescriptor;
}

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string };