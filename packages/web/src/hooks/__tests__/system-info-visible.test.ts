import { describe, expect, it } from 'vitest';
import { formatVisibleSystemInfo } from '../system-info-visible';

describe('formatVisibleSystemInfo', () => {
  it('formats agent_ack as an immediate visible receipt', () => {
    expect(formatVisibleSystemInfo({ type: 'agent_ack', catId: 'gpt52' })).toEqual({
      content: '🔍 gpt52 已接球，正在处理。',
      variant: 'info',
    });
  });
});
