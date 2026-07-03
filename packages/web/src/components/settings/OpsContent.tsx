'use client';

import { useState } from 'react';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubObservabilityTab } from '../HubObservabilityTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { DangerousActionAuditPanel } from './DangerousActionAuditPanel';
import {
  DEFAULT_OPS_SUBSECTION,
  OPS_GROUP_LABELS,
  OPS_GROUP_ORDER,
  OPS_SUBSECTIONS,
  type OpsSubsection,
  type OpsSubsectionGroup,
} from './ops-nav-config';

export function OpsContent() {
  const [activeTab, setActiveTab] = useState(DEFAULT_OPS_SUBSECTION);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<OpsSubsectionGroup>>(() => new Set(['basic']));

  const toggleGroup = (group: OpsSubsectionGroup) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const renderPill = (sub: OpsSubsection) => (
    <button
      key={sub.id}
      type="button"
      onClick={() => setActiveTab(sub.id)}
      className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors ${
        activeTab === sub.id ? 'bg-cafe-accent text-[var(--cafe-surface)]' : 'console-pill text-cafe-secondary hover:text-cafe'
      }`}
    >
      {sub.label}
    </button>
  );

  return (
    <div>
      <div className="mb-5 space-y-2">
        <div className="flex gap-1.5 flex-wrap">
          {OPS_SUBSECTIONS.filter((sub) => sub.group === 'basic').map(renderPill)}
        </div>
        {OPS_GROUP_ORDER.filter((group) => group !== 'basic').map((group) => {
          const subs = OPS_SUBSECTIONS.filter((sub) => sub.group === group);
          if (subs.length === 0) return null;
          const expanded = expandedGroups.has(group);
          return (
            <div key={group} className="rounded-lg border border-[var(--console-border-soft)] px-2 py-1.5">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-cafe-muted"
                aria-expanded={expanded}
              >
                <span>{OPS_GROUP_LABELS[group]}</span>
                <span aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>
              {expanded && <div className="mt-2 flex flex-wrap gap-1.5">{subs.map(renderPill)}</div>}
            </div>
          );
        })}
      </div>
      <OpsSubsectionContent subsection={activeTab} />
    </div>
  );
}

function OpsSubsectionContent({ subsection }: { subsection: string }) {
  switch (subsection) {
    case 'usage':
      return (
        <div className="space-y-6">
          <HubRoutingPolicyTab />
          <HubToolUsageTab />
        </div>
      );
    case 'leaderboard':
      return <HubLeaderboardTab />;
    case 'observability':
      return <HubObservabilityTab />;
    case 'audit':
      return <DangerousActionAuditPanel />;
    case 'health':
      return (
        <div className="space-y-6">
          <HubGovernanceTab />
          <BrakeSettingsPanel />
        </div>
      );
    case 'commands':
      return <HubCommandsTab />;
    case 'rescue':
      return <HubClaudeRescueSection />;
    default:
      return null;
  }
}
