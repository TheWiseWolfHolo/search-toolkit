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
      adapter: "querit" | "serper" | "doubao" | "jina" | "tinyfish" | "brave" | "grok";
      baseUrl?: string;
    };

export interface ProviderConfig {
  enabled: boolean;
  automatic: boolean;
  manualOnly?: boolean;
  keys: string[];
  integration: IntegrationConfig;
  options?: Record<string, unknown>;
}

export interface ToolkitConfig {
  version: 1;
  statePath: string;
  providers: Record<string, ProviderConfig>;
}

export interface KeySelection {
  provider: string;
  slot: number;
  key: string;
  masked: string;
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
}

export interface NormalizedResult {
  provider: string;
  keySlot: string;
  latencyMs: number;
  items: SearchItem[];
  answer?: string;
}
