import type { CatConfig } from '../types/cat.js';

export interface CanCatHandleTaskInput {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function taskText(input: CanCatHandleTaskInput | string): string {
  if (typeof input === 'string') return normalize(input);
  return normalize([input.title, input.description, ...(input.tags ?? [])].filter(Boolean).join(' '));
}

function containsAny(haystack: string, needles: readonly string[] | undefined): boolean {
  if (!needles || needles.length === 0) return false;
  return needles.some((needle) => {
    const value = normalize(needle);
    return value.length > 0 && haystack.includes(value);
  });
}

/**
 * Returns whether a cat profile is a reasonable fit for a task.
 *
 * No contract means "unknown but allowed" for backward compatibility. Once a
 * contract exists, explicit avoid terms win over positive matches.
 */
export function canCatHandleTask(
  cat: Pick<CatConfig, 'capabilityContract'>,
  input: CanCatHandleTaskInput | string,
): boolean {
  const contract = cat.capabilityContract;
  if (!contract) return true;

  const text = taskText(input);
  if (!text) return true;
  if (containsAny(text, contract.shouldAvoid)) return false;

  return (
    containsAny(text, contract.primaryRoles) ||
    containsAny(text, contract.canHandle) ||
    containsAny(text, contract.handoffTriggers)
  );
}
