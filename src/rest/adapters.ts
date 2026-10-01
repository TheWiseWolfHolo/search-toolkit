import type { RestAdapter } from "./base.js";
import { BraveAdapter } from "./providers/brave.js";
import { DoubaoAdapter } from "./providers/doubao.js";
import { GrokAdapter } from "./providers/grok.js";
import { JinaAdapter } from "./providers/jina.js";
import { ParallelAdapter } from "./providers/parallel.js";
import { QueritAdapter } from "./providers/querit.js";
import { SerperAdapter } from "./providers/serper.js";
import { TinyfishAdapter } from "./providers/tinyfish.js";
import { YouAdapter } from "./providers/you.js";

export {
  BraveAdapter, DoubaoAdapter, GrokAdapter, JinaAdapter, ParallelAdapter,
  QueritAdapter, SerperAdapter, TinyfishAdapter, YouAdapter,
};

const ADAPTERS: Record<string, () => RestAdapter> = {
  querit: () => new QueritAdapter(),
  serper: () => new SerperAdapter(),
  doubao: () => new DoubaoAdapter(),
  jina: () => new JinaAdapter(),
  tinyfish: () => new TinyfishAdapter(),
  brave: () => new BraveAdapter(),
  you: () => new YouAdapter(),
  parallel: () => new ParallelAdapter(),
  grok: () => new GrokAdapter(),
};

export const REST_ADAPTER_NAMES = Object.keys(ADAPTERS);

export function adapterFor(name: string): RestAdapter {
  const factory = ADAPTERS[name];
  if (!factory) throw new Error(`Unknown REST adapter: ${name}`);
  return factory();
}
