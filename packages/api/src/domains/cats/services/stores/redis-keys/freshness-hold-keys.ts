/** Redis key patterns for persistent Freshness Hold records. */
export const FreshnessHoldKeys = {
  detail: (id: string) => `freshness-hold:record:${id}`,
  submission: (invocationId: string, submissionKey: string) =>
    `freshness-hold:submission:${encodeURIComponent(invocationId)}:${encodeURIComponent(submissionKey)}`,
  DEADLINES: 'freshness-hold:deadlines',
} as const;
