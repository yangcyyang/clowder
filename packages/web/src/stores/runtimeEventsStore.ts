'use client';

import { create } from 'zustand';
import type { RuntimeSystemEvent } from '@/utils/runtime-notices';

interface RuntimeEventsState {
  events: RuntimeSystemEvent[];
  addEvent: (event: RuntimeSystemEvent) => void;
}

const MAX_EVENTS = 100;

export const useRuntimeEventsStore = create<RuntimeEventsState>((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => {
      if (state.events.some((item) => item.id === event.id)) return state;
      return { events: [event, ...state.events].slice(0, MAX_EVENTS) };
    }),
}));
