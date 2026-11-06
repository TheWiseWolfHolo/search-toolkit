import {
  CapabilityGateError, isKeyFaultStatus, isPlanLimit, isQuotaExhausted, isTimeout, PlanLimitError,
  shouldRetryWithNextKey, statusFromError, TargetPageError,
} from "./errors.js";
import type { RotationStore } from "./rotation.js";
import type { KeySelection, KeyTier, ProviderConfig } from "./types.js";

const MAX_KEY_ATTEMPTS = 3;

export interface RotationCall {
  /** Upstream and exposed names of the tool being called; per-slot tool rules and paidTools match either. */
  tools: readonly string[];
  /** Run on exactly this slot, healthy or not, with no fallback (probes). */
  pin?: number;
}

/** A slot's tier: its own, else the provider default, else unknown. */
export function slotTier(config: ProviderConfig, slot: number): KeyTier | undefined {
  return config.keyMeta?.[slot]?.tier ?? config.defaultTier;
}

/**
 * Slots that may run this tool under the operator's annotations. Undefined
 * means every slot, which keeps a sticky pointer free to move.
 */
export function eligibleSlots(config: ProviderConfig, tools: readonly string[]): number[] | undefined {
  const paidOnly = tools.some((tool) => config.paidTools?.includes(tool));
  if (!paidOnly && !config.keyMeta?.some((meta) => meta.allowTools || meta.denyTools)) return undefined;
  const slots = config.keys.flatMap((_, slot) => {
    const meta = config.keyMeta?.[slot];
    if (meta?.allowTools && !tools.some((tool) => meta.allowTools?.includes(tool))) return [];
    if (meta?.denyTools && tools.some((tool) => meta.denyTools?.includes(tool))) return [];
    if (paidOnly && slotTier(config, slot) !== "paid") return [];
    return [slot];
  });
  return slots.length === config.keys.length ? undefined : slots;
}

/**
 * Run one provider call on the next healthy key the tool may use. A key fault
 * (401/402/403/429, or out of credit) moves on to up to two more distinct
 * keys. A transient fault (5xx, dropped connection) gets one more key, since
 * it is rarely the key's doing and automatic routes would rather try another
 * provider. A plan limit ("not allowed for free accounts") moves to a paid key
 * when the pool has one, and otherwise lets automatic routes try the next
 * provider. Timeouts, target page failures, request-shape errors, and
 * tool-level errors are returned untouched: another key would not change them.
 */
export async function callWithRotation<T>(
  rotation: RotationStore,
  provider: string,
  config: ProviderConfig,
  call: RotationCall,
  attempt: (selection: KeySelection) => Promise<T>,
): Promise<T> {
  const keys = config.keys;
  if (call.pin !== undefined) return attempt(rotation.select(provider, keys, { pin: call.pin }));
  const eligible = eligibleSlots(config, call.tools);
  if (eligible && eligible.length === 0) {
    throw new CapabilityGateError(`${provider} has no key slot allowed to call ${call.tools[0] ?? "this tool"}${
      call.tools.some((tool) => config.paidTools?.includes(tool)) ? " (paid tier required)" : ""}`);
  }
  const maxAttempts = Math.min(Math.max(eligible?.length ?? keys.length, 1), MAX_KEY_ATTEMPTS);
  const tried = new Set<number>();
  let paidOnly = false;
  let transientRetried = false;
  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    const allowed = paidOnly ? (eligible ?? keys.map((_, slot) => slot)).filter((slot) => slotTier(config, slot) === "paid") : eligible;
    let selection: KeySelection;
    try {
      selection = rotation.select(provider, keys, {
        strategy: config.strategy ?? "round_robin",
        ...(allowed ? { eligible: allowed } : {}),
        exclude: tried,
      });
    } catch (selectError) {
      throw lastError ?? selectError;
    }
    tried.add(selection.slot);
    try {
      return await attempt(selection);
    } catch (error) {
      lastError = error;
      if (error instanceof TargetPageError || isTimeout(error)) throw error;
      if (isPlanLimit(error)) {
        const planError = new PlanLimitError(error);
        // Only a paid key can do better; the pool has none left to try, so let the route move on.
        const paidLeft = keys.some((_, slot) => !tried.has(slot) && slotTier(config, slot) === "paid"
          && (!eligible || eligible.includes(slot)));
        if (!paidLeft || index + 1 >= maxAttempts) throw planError;
        lastError = planError;
        paidOnly = true;
        continue;
      }
      if (index + 1 >= maxAttempts) throw error;
      const status = statusFromError(error);
      if (isQuotaExhausted(error)) continue;
      if (!shouldRetryWithNextKey(status)) throw error;
      if (!isKeyFaultStatus(status)) {
        if (transientRetried) throw error;
        transientRetried = true;
      }
    }
  }
  throw lastError;
}

/** What `record` needs to know about a failed call beyond its status code. */
export function failureFlags(error: unknown): { exhausted?: true; planLimit?: true } {
  if (isQuotaExhausted(error)) return { exhausted: true };
  if (isPlanLimit(error)) return { planLimit: true };
  return {};
}
