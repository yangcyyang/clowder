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
    expect(total?.sourceBreakdown).toEqual({
      totalEstimatedTokens: 2500,
      sources: [
        { source: 'history', chars: 3600, estimatedTokens: 900 },
        { source: 'rules', chars: 1600, estimatedTokens: 400 },
        { source: 'skill', chars: 4800, estimatedTokens: 1200 },
      ],
    });
  });

  it('reads history governance summary fields from usage events', () => {
    const summaries = readTaskUsageSummaries(
      task([
        {
          ts: new Date().toISOString(),
          catId: 'codex',
          type: 'usage',
          data: {
            historyMode: 'shadow-summary',
            historyFullTokens: 12000,
            historySummaryTokens: 900,
            historyBudgetRatio: 0.4,
            summarySegmentId: 'summary-1',
            historyGovernanceDegraded: false,
          },
        },
        {
          ts: new Date().toISOString(),
          catId: 'claude',
          type: 'usage',
          data: {
            historyMode: 'summary-active',
            historyFullTokens: 18000,
            historySummaryTokens: 700,
            historyBudgetRatio: 0.6,
            summarySegmentId: 'summary-2',
            historyGovernanceDegraded: true,
          },
        },
      ]),
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      historyMode: 'shadow-summary',
      historyFullTokens: 12000,
      historySummaryTokens: 900,
      historyBudgetRatio: 0.4,
      summarySegmentId: 'summary-1',
      historyGovernanceDegraded: false,
    });

    const total = summarizeTaskUsage(summaries);
    expect(total).toMatchObject({
      historyMode: 'summary-active',
      historyFullTokens: 18000,
      historySummaryTokens: 700,
      historyBudgetRatio: 0.6,
      summarySegmentId: 'summary-2',
      historyGovernanceDegraded: true,
    });
  });
});
