export type OpsSubsectionGroup = 'basic' | 'advanced' | 'experimental';

export interface OpsSubsection {
  id: string;
  label: string;
  group: OpsSubsectionGroup;
}

export const OPS_SUBSECTIONS: OpsSubsection[] = [
  { id: 'health', label: '治理与刹车', group: 'basic' },
  { id: 'commands', label: '命令速查', group: 'basic' },
  { id: 'rescue', label: '紧急救援', group: 'basic' },
  { id: 'usage', label: '用量/配额', group: 'advanced' },
  { id: 'observability', label: '监控面板', group: 'advanced' },
  { id: 'audit', label: '审计日志', group: 'advanced' },
  { id: 'leaderboard', label: '排行榜', group: 'experimental' },
];

export const OPS_GROUP_LABELS: Record<OpsSubsectionGroup, string> = {
  basic: '常用',
  advanced: '高级',
  experimental: '实验区',
};

export const OPS_GROUP_ORDER: OpsSubsectionGroup[] = ['basic', 'advanced', 'experimental'];

export const DEFAULT_OPS_SUBSECTION = 'health';
