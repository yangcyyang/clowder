/**
 * Vote utilities shared by HTTP routes and callback notifications.
 *
 * Routing must not parse agent prose as protocol commands. Vote casting stays
 * on explicit APIs, while these helpers only build result/notification payloads.
 */

import type { ConnectorSource } from '@cat-cafe/shared';
import type { VotingStateV1 } from '../cats/services/stores/ports/ThreadStore.js';

/** Vote results render as ConnectorBubble, not plain system message. */
export const VOTE_RESULT_SOURCE: ConnectorSource = {
  connector: 'vote-result',
  label: '投票结果',
  icon: 'ballot',
};

/**
 * Check if all designated voters have voted.
 * Returns true only when a `voters` list exists and every voter has cast.
 */
export function checkVoteCompletion(state: VotingStateV1): boolean {
  const voters = (state as VotingStateV1 & { voters?: string[] }).voters;
  if (!voters || voters.length === 0) return false;
  return voters.every((v) => v in state.votes);
}

/**
 * Build the notification message sent to each voter.
 */
export function buildVoteNotification(question: string, options: string[]): string {
  const optionList = options.map((o) => `• ${o}`).join('\n');
  return `投票请求：${question}\n\n选项：\n${optionList}\n\n请在投票组件中选择一个选项。`;
}

/**
 * Build tally object from votes.
 */
export function buildVoteTally(options: string[], votes: Record<string, string>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const opt of options) tally[opt] = 0;
  for (const v of Object.values(votes)) {
    tally[v] = (tally[v] ?? 0) + 1;
  }
  return tally;
}
