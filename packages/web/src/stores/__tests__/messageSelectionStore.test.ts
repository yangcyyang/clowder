import { beforeEach, describe, expect, it } from 'vitest';
import { isMessageSelected, useMessageSelectionStore } from '../messageSelectionStore';

describe('messageSelectionStore', () => {
  beforeEach(() => {
    useMessageSelectionStore.setState({ threadId: null, selectedIds: [] });
  });

  it('start() enters selection mode for a thread, pre-selecting one message', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    const state = useMessageSelectionStore.getState();
    expect(state.threadId).toBe('thread-1');
    expect(state.selectedIds).toEqual(['msg-1']);
  });

  it('toggle() adds a message to an active selection in the same thread', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    useMessageSelectionStore.getState().toggle('thread-1', 'msg-2');
    expect(useMessageSelectionStore.getState().selectedIds).toEqual(['msg-1', 'msg-2']);
  });

  it('toggle() removes an already-selected message', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    useMessageSelectionStore.getState().toggle('thread-1', 'msg-2');
    useMessageSelectionStore.getState().toggle('thread-1', 'msg-1');
    expect(useMessageSelectionStore.getState().selectedIds).toEqual(['msg-2']);
  });

  it('toggle() clears selection entirely (threadId back to null) once the last id is removed', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    useMessageSelectionStore.getState().toggle('thread-1', 'msg-1');
    const state = useMessageSelectionStore.getState();
    expect(state.threadId).toBeNull();
    expect(state.selectedIds).toEqual([]);
  });

  it('toggle() targeting a different thread starts a fresh selection there instead of merging', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    useMessageSelectionStore.getState().toggle('thread-2', 'msg-9');
    const state = useMessageSelectionStore.getState();
    expect(state.threadId).toBe('thread-2');
    expect(state.selectedIds).toEqual(['msg-9']);
  });

  it('clear() resets to no active selection', () => {
    useMessageSelectionStore.getState().start('thread-1', 'msg-1');
    useMessageSelectionStore.getState().clear();
    const state = useMessageSelectionStore.getState();
    expect(state.threadId).toBeNull();
    expect(state.selectedIds).toEqual([]);
  });

  describe('isMessageSelected', () => {
    it('returns true only for the matching thread + id combination', () => {
      expect(isMessageSelected('thread-1', ['msg-1', 'msg-2'], 'msg-1')).toBe(true);
      expect(isMessageSelected('thread-1', ['msg-1'], 'msg-2')).toBe(false);
      expect(isMessageSelected(null, ['msg-1'], 'msg-1')).toBe(false);
    });
  });
});
