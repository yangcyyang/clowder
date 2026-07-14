import { describe, expect, it, vi } from 'vitest';
import { settleVisibleThreadReadAck } from '@/hooks/useVisibleThreadReadAck';

describe('settleVisibleThreadReadAck', () => {
  it('does not acknowledge from a hidden or unfocused tab', async () => {
    const arm = vi.fn();
    const confirm = vi.fn();
    const fetcher = vi.fn();

    await expect(
      settleVisibleThreadReadAck({
        threadId: 'thread-branch',
        attention: { visibilityState: 'hidden', hasFocus: false },
        arm,
        confirm,
        fetcher,
      }),
    ).resolves.toBe('skipped');
    expect(arm).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('arms, posts the branch cursor and settles suppression on success', async () => {
    const arm = vi.fn();
    const confirm = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      settleVisibleThreadReadAck({
        threadId: 'thread branch/1',
        attention: { visibilityState: 'visible', hasFocus: true },
        arm,
        confirm,
        fetcher,
      }),
    ).resolves.toBe('acknowledged');
    expect(arm).toHaveBeenCalledWith('thread branch/1');
    expect(fetcher).toHaveBeenCalledWith('/api/threads/thread%20branch%2F1/read/latest', expect.any(Object));
    expect(confirm).toHaveBeenCalledWith('thread branch/1');
  });

  it('settles the pending ledger on non-2xx and thrown requests', async () => {
    for (const fetcher of [vi.fn().mockResolvedValue({ ok: false }), vi.fn().mockRejectedValue(new Error('offline'))]) {
      const arm = vi.fn();
      const confirm = vi.fn();

      await expect(
        settleVisibleThreadReadAck({
          threadId: 'thread-branch',
          attention: { visibilityState: 'visible', hasFocus: true },
          arm,
          confirm,
          fetcher,
        }),
      ).resolves.toBe('failed');
      expect(arm).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();
    }
  });
});
