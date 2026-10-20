import { isKeyFaultStatus, isTimeout, shouldRetryWithNextKey, statusFromError, TargetPageError } from "./errors.js";
import type { RotationStore } from "./rotation.js";
import type { KeySelection } from "./types.js";

const MAX_KEY_ATTEMPTS = 3;

/**
 * Run one provider call on the next healthy key. A key fault (401/402/403/429)
 * moves on to up to two more distinct healthy keys. A transient fault (5xx,
 * dropped connection) gets one more key, since it is rarely the key's doing
 * and automatic routes would rather try another provider. Timeouts, target
 * page failures, request-shape errors, and tool-level errors are returned
 * untouched: another key would not change them.
 */
export async function callWithRotation<T>(
  rotation: RotationStore,
  provider: string,
  keys: string[],
  attempt: (selection: KeySelection) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.min(Math.max(keys.length, 1), MAX_KEY_ATTEMPTS);
  const triedSlots = new Set<number>();
  let transientRetried = false;
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
      if (index + 1 >= maxAttempts || error instanceof TargetPageError || isTimeout(error)) throw error;
      const status = statusFromError(error);
      if (!shouldRetryWithNextKey(status)) throw error;
      if (!isKeyFaultStatus(status)) {
        if (transientRetried) throw error;
        transientRetried = true;
      }
    }
  }
  throw lastError;
}
