import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifySanityState,
  computeSanityTransition,
  DEFAULT_SANITY_THRESHOLDS,
  getSanityThresholdsFromEnv,
} from '../dist/domains/cats/services/session/SessionSanityMonitor.js';

const SANITY_LINE = 200_000;

describe('理智线 T3 (task #385): classifySanityState', () => {
  it('classifies below yellow threshold as green', () => {
    assert.equal(classifySanityState(100_000, SANITY_LINE), 'green'); // 50%
  });

  it('classifies at/above yellow but below red as yellow', () => {
    assert.equal(classifySanityState(150_000, SANITY_LINE), 'yellow'); // 75%
    assert.equal(classifySanityState(140_000, SANITY_LINE), 'yellow'); // exactly 70%
  });

  it('classifies at/above red threshold as red', () => {
    assert.equal(classifySanityState(192_000, SANITY_LINE), 'red'); // 96%
    assert.equal(classifySanityState(190_000, SANITY_LINE), 'red'); // exactly 95%
  });

  it('custom thresholds shift the tier boundaries', () => {
    const thresholds = { yellowRatio: 0.5, redRatio: 0.9 };
    assert.equal(classifySanityState(90_000, SANITY_LINE, thresholds), 'green'); // 45% < 50% yellow threshold, still green
    assert.equal(classifySanityState(100_000, SANITY_LINE, thresholds), 'yellow'); // 50% now crosses yellow
    assert.equal(classifySanityState(180_000, SANITY_LINE, thresholds), 'red'); // 90% crosses red
  });

  it('is robust against a missing/zero sanityLine (defaults to green rather than throwing)', () => {
    assert.equal(classifySanityState(50_000, 0), 'green');
  });
});

describe('理智线 T3 (task #385): getSanityThresholdsFromEnv', () => {
  it('falls back to defaults when env vars are unset', () => {
    assert.deepEqual(getSanityThresholdsFromEnv({}), DEFAULT_SANITY_THRESHOLDS);
  });

  it('reads valid overrides from env', () => {
    const thresholds = getSanityThresholdsFromEnv({
      CAT_CAFE_SANITY_YELLOW_RATIO: '0.5',
      CAT_CAFE_SANITY_RED_RATIO: '0.9',
    });
    assert.deepEqual(thresholds, { yellowRatio: 0.5, redRatio: 0.9 });
  });

  it('rejects out-of-range or non-numeric overrides and falls back to defaults', () => {
    assert.deepEqual(
      getSanityThresholdsFromEnv({ CAT_CAFE_SANITY_YELLOW_RATIO: 'not-a-number' }),
      DEFAULT_SANITY_THRESHOLDS,
    );
    assert.deepEqual(getSanityThresholdsFromEnv({ CAT_CAFE_SANITY_RED_RATIO: '1.5' }), DEFAULT_SANITY_THRESHOLDS);
    assert.deepEqual(getSanityThresholdsFromEnv({ CAT_CAFE_SANITY_RED_RATIO: '0' }), DEFAULT_SANITY_THRESHOLDS);
  });
});

describe('理智线 T3 (task #385): computeSanityTransition — kimi spec acceptance sequence', () => {
  it('emits events only on tier crossings for the sequence [50%, 75%, 80%, 96%, 60%]', () => {
    const ratios = [0.5, 0.75, 0.8, 0.96, 0.6];
    let state;
    const events = [];
    for (const ratio of ratios) {
      const usedTokens = ratio * SANITY_LINE;
      const result = computeSanityTransition(state, usedTokens, SANITY_LINE);
      state = result.state;
      if (result.event) events.push(`${result.event.from}->${result.event.to}`);
    }
    assert.deepEqual(events, ['green->yellow', 'yellow->red', 'red->green']);
  });

  it('does not emit an event on the very first turn when it starts green (no prior state)', () => {
    const result = computeSanityTransition(undefined, 100_000, SANITY_LINE);
    assert.equal(result.state, 'green');
    assert.equal(result.event, null);
  });

  it('does emit an event when a brand-new session starts already yellow/red on turn one', () => {
    const result = computeSanityTransition(undefined, 190_000, SANITY_LINE); // 95% → red on first turn
    assert.equal(result.state, 'red');
    assert.deepEqual(result.event, { from: 'green', to: 'red', ratio: 0.95 });
  });

  it('does not emit an event when staying in the same tier turn over turn', () => {
    const first = computeSanityTransition(undefined, 150_000, SANITY_LINE); // yellow
    assert.equal(first.event?.to, 'yellow');
    const second = computeSanityTransition(first.state, 160_000, SANITY_LINE); // still yellow
    assert.equal(second.state, 'yellow');
    assert.equal(second.event, null);
  });

  it('threshold env overrides shift the transition points (0.5 / 0.9)', () => {
    const thresholds = { yellowRatio: 0.5, redRatio: 0.9 };
    const a = computeSanityTransition(undefined, 0.4 * SANITY_LINE, SANITY_LINE, thresholds);
    assert.equal(a.state, 'green');
    const b = computeSanityTransition(a.state, 0.5 * SANITY_LINE, SANITY_LINE, thresholds);
    assert.deepEqual(b.event, { from: 'green', to: 'yellow', ratio: 0.5 });
    const c = computeSanityTransition(b.state, 0.9 * SANITY_LINE, SANITY_LINE, thresholds);
    assert.deepEqual(c.event, { from: 'yellow', to: 'red', ratio: 0.9 });
  });

  it('event payload carries catId/threadId-relevant fields (ratio, from, to) for the caller to enrich', () => {
    const result = computeSanityTransition('green', 150_000, SANITY_LINE);
    assert.ok(typeof result.event.ratio === 'number');
    assert.equal(result.event.from, 'green');
    assert.equal(result.event.to, 'yellow');
  });
});
