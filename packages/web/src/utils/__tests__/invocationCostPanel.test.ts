import type { TaskItem } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { readTaskUsageSummaries, summarizeTaskUsage } from '../invocationCostPanel';

function task(events: TaskItem['events']): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: 'Measure usage',
    why: '',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    ownerCatId: null,
    status: 'doing',
    events,
  };
}

describe('invocationCostPanel', () => {
  it('reads and merges prompt source breakdown from usage events', () => {
    const summaries = readTaskUsageSummaries(
      task([
        {
          ts: new Date().toISOString(),
          catId: 'codex',
          type: 'usage',
          data: {
            inputTokens: 1000,
            outputTokens: 500,
            historyMode: 'shadow-summary',
            historyFullTokens: 12000,
            historySummaryTokens: 420,
            historyBudgetRatio: 0.4,
            summarySegmentId: 'seg-001',
            historyGovernanceDegraded: false,
            sourceBreakdown: {
              totalEstimatedTokens: 1000,
              sources: [
                { source: 'history', chars: 2400, estimatedTokens: 600 },
                { source: 'rules', chars: 1600, estimatedTokens: 400 },
              ],
            },
          },
        },
        {
          ts: new Date().toISOString(),
          catId: 'claude',
          type: 'usage',
          data: {
            inputTokens: 2000,
            outputTokens: 1000,
            historyMode: 'observe',
            historyFullTokens: 18000,
            historyBudgetRatio: 0.6,
            historyGovernanceDegraded: true,
            sourceBreakdown: {
              totalEstimatedTokens: 1500,
              sources: [
                { source: 'history', chars: 1200, estimatedTokens: 300 },
                { source: 'skill', chars: 4800, estimatedTokens: 1200 },
              ],
            },
          },
        },
      ]),
    );

    const total = summarizeTaskUsage(summaries);
    expect(summaries[0]).toMatchObject({
      historyMode: 'shadow-summary',
      historyFullTokens: 12000,
      historySummaryTokens: 420,
      historyBudgetRatio: 0.4,
      summarySegmentId: 'seg-001',
      historyGovernanceDegraded: false,
    });
    expect(total).toMatchObject({
      historyMode: 'observe',
      historyFullTokens: 18000,
      historyBudgetRatio: 0.6,
      historyGovernanceDegraded: true,
    });
    expect(total?.sourceBreakdown).toEqual({
      totalEstimatedTokens: 2500,
      sources: [
        { source: 'history', chars: 3600, estimatedTokens: 900 },
        { source: 'rules', chars: 1600, estimatedTokens: 400 },
        { source: 'skill', chars: 4800, estimatedTokens: 1200 },
      ],
    });
  });
});
