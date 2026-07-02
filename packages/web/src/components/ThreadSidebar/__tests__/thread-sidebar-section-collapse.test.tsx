import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar section collapse controls', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  it('collapses and expands the channel list without removing the header', async () => {
    await harness.render();

    expect(harness.container.textContent).toContain('CHANNELS');
    expect(harness.container.textContent).toContain('大厅');

    const collapseButton = harness.container.querySelector('button[aria-label="折叠频道"]') as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    await act(async () => {
      collapseButton?.click();
    });
    await harness.flush();

    expect(harness.container.textContent).toContain('CHANNELS');
    expect(harness.container.textContent).not.toContain('大厅');

    const expandButton = harness.container.querySelector('button[aria-label="展开频道"]') as HTMLButtonElement | null;
    expect(expandButton).not.toBeNull();

    await act(async () => {
      expandButton?.click();
    });
    await harness.flush();

    expect(harness.container.textContent).toContain('大厅');
  });
});
