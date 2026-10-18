import { shouldRetryWithNextKey, statusFromError } from "./errors.js";
import type { RotationStore } from "./rotation.js";
import type { KeySelection } from "./types.js";

const MAX_KEY_ATTEMPTS = 3;

/**
 * Run one provider call on the next healthy key; after a failure that another
 * key could plausibly fix, retry on up to two additional distinct healthy keys.
 * Request-shape errors (400/404/422) and tool-level errors are returned untouched.
 */
export async function callWithRotation<T>(
  rotation: RotationStore,
  provider: string,
  keys: string[],
  attempt: (selection: KeySelection) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.min(Math.max(keys.length, 1), MAX_KEY_ATTEMPTS);
  const triedSlots = new Set<number>();
  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    let selection: KeySelection;
    try {
      selection = rotation.select(provider, keys);
    } catch (selectError) {
      throw lastError ?? selectError;
    }
    if (triedSlots.has(selection.slot)) break;
    triedSlots.add(selection.slot);
    try {
      return await attempt(selection);
    } catch (error) {
      lastError = error;
      if (index + 1 >= maxAttempts || !shouldRetryWithNextKey(statusFromError(error))) throw error;
    }
  }
  throw lastError;
}
