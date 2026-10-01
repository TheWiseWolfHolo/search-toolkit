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
      adapter: "querit" | "serper" | "doubao" | "jina" | "tinyfish" | "brave" | "you" | "parallel" | "grok";
      baseUrl?: string;
    };

/** What a provider may be chosen for without being named explicitly. An empty list means manual use only. */
export type AutoCapability = "search" | "images" | "fetch";

export interface ProviderConfig {
  enabled: boolean;
  auto: AutoCapability[];
  keys: string[];
  integration: IntegrationConfig;
  toolPolicy?: {
    allow?: string[];
    deny?: string[];
    /** Replace the exposed description of a tool, keyed by its upstream name. */
    descriptions?: Record<string, string>;
  };
  options?: Record<string, unknown>;
}

export type ToolkitProfile = "full" | "lean";

export interface ShapingConfig {
  /** Longest exposed tool description; 0 keeps upstream text untouched. */
  maxDescriptionChars?: number;
  /** Longest description on a single input parameter; 0 keeps them untouched. */
  maxParamDescriptionChars?: number;
}

export interface ToolkitConfig {
  version: 2;
  statePath: string;
  profile?: ToolkitProfile;
  shaping?: ShapingConfig;
  providers: Record<string, ProviderConfig>;
}

export interface KeySelection {
  provider: string;
  slot: number;
  key: string;
  masked: string;
  fingerprint: string;
}

export interface ToolBinding {
  exposed: Tool;
  provider: string;
  upstreamName: string;
  call(arguments_: Record<string, unknown>): Promise<unknown>;
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
