import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type AuthConfig =
  | { kind: "header"; name: string }
  | { kind: "bearer" }
  | { kind: "query"; name: string }
  | { kind: "none" };

export type IntegrationConfig =
  | {
      kind: "remote_mcp";
      url: string;
      auth: AuthConfig;
      headers?: Record<string, string>;
    }
  | {
      kind: "stdio_mcp";
      command: string;
      args: string[];
      envKey: string;
      env?: Record<string, string>;
    }
  | {
      kind: "rest";
      adapter: "querit" | "serper" | "doubao" | "jina" | "tinyfish" | "brave" | "you" | "parallel" | "grok" | "octen";
      baseUrl?: string;
    };

/** What a provider may be chosen for without being named explicitly. An empty list means manual use only. */
export type AutoCapability = "search" | "images" | "fetch";

/** How a provider's key pool is walked. */
export type KeyStrategy = "round_robin" | "sticky" | "drain";

/** The subscription plan a key belongs to, when the operator has said so. */
export type KeyTier = "free" | "paid";

/** Per-slot annotations; `keys` stays a plain string list so every consumer keeps working. */
export interface KeyMeta {
  tier?: KeyTier;
  label?: string;
  /** Only these tools (upstream or exposed names) may use this key. */
  allowTools?: string[];
  /** These tools never use this key. */
  denyTools?: string[];
}

export interface ProviderConfig {
  enabled: boolean;
  auto: AutoCapability[];
  keys: string[];
  /** Same length as `keys` when any slot is annotated. */
  keyMeta?: KeyMeta[];
  /** round_robin (default) spreads load; sticky stays on one key until it fails; drain uses keys in order. */
  strategy?: KeyStrategy;
  /** Tier for slots that do not name one. */
  defaultTier?: KeyTier;
  /** Tools that only paid-tier keys may call. */
  paidTools?: string[];
  integration: IntegrationConfig;
  toolPolicy?: {
    allow?: string[];
    deny?: string[];
    /** Replace the exposed description of a tool, keyed by its upstream name. */
    descriptions?: Record<string, string>;
  };
  options?: Record<string, unknown>;
}

export type ToolkitProfile = "full" | "curated" | "lean";

export interface ShapingConfig {
  /** Longest exposed tool description; 0 keeps upstream text untouched. */
  maxDescriptionChars?: number;
  /** Longest description on a single input parameter; 0 keeps them untouched. */
  maxParamDescriptionChars?: number;
}

/** Short-lived reuse of unified-tool results. Seconds; 0 turns that kind off. */
export interface CacheConfig {
  enabled?: boolean;
  searchTtlSeconds?: number;
  newsTtlSeconds?: number;
  fetchTtlSeconds?: number;
}

export interface ToolkitConfig {
  version: 2;
  statePath: string;
  profile?: ToolkitProfile;
  shaping?: ShapingConfig;
  cache?: CacheConfig;
  providers: Record<string, ProviderConfig>;
}

export interface KeySelection {
  provider: string;
  slot: number;
  key: string;
  masked: string;
  fingerprint: string;
}

export interface CallOptions {
  /** Run on this key slot only, healthy or not (rotation probes). */
  slot?: number;
}

export interface ToolBinding {
  exposed: Tool;
  provider: string;
  upstreamName: string;
  call(arguments_: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
}

export interface SearchItem {
  title: string;
  url: string;
  text: string;
  /** Publication or crawl date as the provider reports it (ISO date when available). */
  date?: string;
}

export interface ImageSearchItem extends SearchItem {
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  source?: string;
  domain?: string;
  position?: number;
}

export interface NormalizedResult {
  provider: string;
  keySlot: string;
  latencyMs: number;
  items: SearchItem[];
  answer?: string;
}
