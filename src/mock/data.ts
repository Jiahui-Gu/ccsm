import type { Group, Session, MessageBlock } from '../types';

export const mockGroups: Group[] = [
  { id: 'g1', name: 'Backend Refactor', collapsed: false, kind: 'normal' },
  { id: 'g2', name: 'Investigations', collapsed: false, kind: 'normal' },
  { id: 'g3', name: 'Docs', collapsed: true, kind: 'normal' },
  { id: 'g4', name: 'Payments v2', collapsed: true, kind: 'normal' },
  { id: 'g5', name: 'Inference Tuning', collapsed: true, kind: 'normal' },
  { id: 'g6', name: 'Identity Service', collapsed: true, kind: 'normal' },
  { id: 'g7', name: 'Webhook Reliability', collapsed: true, kind: 'normal' },
  { id: 'g8', name: 'Observability Pass', collapsed: true, kind: 'normal' },
  { id: 'g9', name: 'CI Speedup', collapsed: true, kind: 'normal' },
  { id: 'g10', name: 'Mobile API Bridge', collapsed: true, kind: 'normal' },
  { id: 'g11', name: 'Onboarding Tweaks', collapsed: true, kind: 'normal' },
  { id: 'g12', name: 'Search Relevance', collapsed: true, kind: 'normal' },
  { id: 'arch1', name: 'Q1 Migration', collapsed: true, kind: 'archive' },
  { id: 'arch2', name: 'Old Auth Spike', collapsed: true, kind: 'archive' },
  { id: 'arch3', name: 'Legacy Dashboard', collapsed: true, kind: 'archive' },
  { id: 'arch4', name: 'GraphQL Experiment', collapsed: true, kind: 'archive' },
  { id: 'arch5', name: 'Redis Eviction Repro', collapsed: true, kind: 'archive' },
  { id: 'arch6', name: 'Stripe Webhook v1', collapsed: true, kind: 'archive' },
  { id: 'arch7', name: 'Old Inference Pipeline', collapsed: true, kind: 'archive' },
  { id: 'arch8', name: 'Pre-launch QA', collapsed: true, kind: 'archive' }
];

export const mockSessions: Session[] = [
  { id: 's1', name: 'webhook-worker', state: 'waiting', cwd: '~/projects/payments-api', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
  { id: 's2', name: 'webhook-async', state: 'waiting', cwd: '~/projects/payments-api', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
  { id: 's3', name: 'old-sync-impl', state: 'waiting', cwd: '~/projects/payments-api', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
  { id: 's4', name: 'oom-repro', state: 'waiting', cwd: '~/projects/inference-svc', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' },
  { id: 's5', name: 'migrate-users-table', state: 'waiting', cwd: '~/projects/payments-api', model: 'claude-opus-4', groupId: 'arch1', agentType: 'claude-code' },
  { id: 's6', name: 'rollback-script', state: 'waiting', cwd: '~/projects/payments-api', model: 'claude-opus-4', groupId: 'arch1', agentType: 'claude-code' },
  { id: 's7', name: 'oauth-poc', state: 'waiting', cwd: '~/projects/identity-svc', model: 'claude-opus-4', groupId: 'arch2', agentType: 'claude-code' }
];

export const mockMessages: MessageBlock[] = [
  { kind: 'user', id: 'm1', text: '把 webhook handler 改成异步队列消费' },
  { kind: 'assistant', id: 'm2', text: '我先看一下当前的 handler 实现，再给方案。' },
  { kind: 'tool', id: 'm3', name: 'Read', brief: 'src/webhook/handler.ts', expanded: false },
  { kind: 'tool', id: 'm4', name: 'Grep', brief: '"publish\\(", src/', expanded: false },
  { kind: 'tool', id: 'm5', name: 'Bash', brief: 'npm test -- webhook', expanded: false },
  { kind: 'assistant', id: 'm6', text: '方案：抽出 WebhookJob，用 BullMQ 做队列。需要新增 redis 依赖，确认可以吗？' },
  { kind: 'waiting', id: 'm7', prompt: 'Add dependency: bullmq@^5', intent: 'permission' }
];

export const activeSessionId = 's2';

export type RecentProject = { id: string; name: string; path: string };

export const mockRecentProjects: RecentProject[] = [
  { id: 'p1', name: 'ccsm', path: '~/projects/ccsm' },
  { id: 'p2', name: 'payments-api', path: '~/projects/payments-api' },
  { id: 'p3', name: 'inference-svc', path: '~/projects/inference-svc' },
  { id: 'p4', name: 'identity-svc', path: '~/projects/identity-svc' },
  { id: 'p5', name: 'ccsm', path: '~/projects/ccsm' },
  { id: 'p6', name: 'webhook-gateway', path: '~/projects/webhook-gateway' }
];
