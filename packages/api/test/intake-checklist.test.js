import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DEFAULT_INTAKE_CHECKLIST, validateIntakeChecklist } = await import('@cat-cafe/shared');

test('retired intake checklist helpers are not exposed from the shared public API', () => {
  assert.equal(DEFAULT_INTAKE_CHECKLIST, undefined);
  assert.equal(validateIntakeChecklist, undefined);
});
