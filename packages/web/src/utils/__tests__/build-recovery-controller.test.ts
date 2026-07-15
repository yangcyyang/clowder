import { describe, expect, it, vi } from 'vitest';
import { createBuildRecoveryController } from '../build-recovery-controller';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('build-recovery-controller', () => {
  it('compares builds, announces once, and reserves one automatic reload per target', () => {
    const controller = createBuildRecoveryController({
      currentBuildId: 'controller-a',
      storage: memoryStorage(),
      hasUnsavedWork: () => false,
    });

    expect(controller.handleProbeResult('controller-a')).toEqual([]);
    expect(controller.handleProbeResult('controller-b')).toEqual([
      { type: 'announce', buildId: 'controller-b' },
      {
        type: 'reload',
        source: 'product-recovery',
        fromBuildId: 'controller-a',
        toBuildId: 'controller-b',
        trigger: 'automatic',
      },
    ]);
    expect(controller.handleProbeResult('controller-b')).toEqual([]);
    expect(controller.snapshot().loopPrevented).toBe(true);
  });

  it('caps three failed probes, suppresses the fourth, and resets on attention', () => {
    const controller = createBuildRecoveryController({
      currentBuildId: 'controller-failure-a',
      storage: memoryStorage(),
      hasUnsavedWork: () => false,
    });

    expect(controller.canProbe()).toBe(true);
    controller.handleProbeResult(null);
    controller.handleProbeResult(null);
    controller.handleProbeResult(null);
    expect(controller.canProbe()).toBe(false);
    controller.resetProbeFailures();
    expect(controller.canProbe()).toBe(true);
  });

  it('turns a draft into a pending prompt and emits a manual reload action', () => {
    const hasUnsavedWork = vi.fn(() => true);
    const controller = createBuildRecoveryController({
      currentBuildId: 'controller-draft-b',
      storage: memoryStorage(),
      hasUnsavedWork,
    });

    expect(controller.handleProbeResult('controller-draft-c')).toEqual([
      { type: 'announce', buildId: 'controller-draft-c' },
      {
        type: 'prompt',
        request: { kind: 'build', targetBuildId: 'controller-draft-c' },
      },
    ]);
    expect(controller.snapshot().pendingRequest).toEqual({
      kind: 'build',
      targetBuildId: 'controller-draft-c',
    });
    expect(controller.manualPromptAction()).toEqual([
      {
        type: 'reload',
        source: 'product-recovery',
        fromBuildId: 'controller-draft-b',
        toBuildId: 'controller-draft-c',
        trigger: 'manual',
      },
    ]);
    expect(controller.manualPromptAction()).toEqual([]);
  });
});
