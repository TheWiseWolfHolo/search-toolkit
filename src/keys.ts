import { shouldRetryWithNextKey, statusFromError } from "./errors.js";
import type { RotationStore } from "./rotation.js";
import type { KeySelection } from "./types.js";

/**
 * Run one provider call on the next healthy key; after a failure that another
 * key could plausibly fix, retry once on a different key. Request-shape errors
 * (400/404/422) and tool-level errors are returned to the caller untouched.
 */
export async function callWithRotation<T>(
  rotation: RotationStore,
  provider: string,
  keys: string[],
  attempt: (selection: KeySelection) => Promise<T>,
): Promise<T> {
  const first = rotation.select(provider, keys);
  try {
    return await attempt(first);
  } catch (error) {
    if (keys.length < 2 || !shouldRetryWithNextKey(statusFromError(error))) throw error;
    let next: KeySelection;
    try {
      next = rotation.select(provider, keys);
    } catch {
      throw error;
    }
    if (next.slot === first.slot) throw error;
    return attempt(next);
  }
}
