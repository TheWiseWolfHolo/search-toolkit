import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    // Works from both src/ (tests, ts-node style) and dist/src/ (built): walk up to package.json.
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth += 1) {
      try {
        const parsed = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@thewisewolfholo/search-toolkit" && parsed.version) return parsed.version;
      } catch {
        // keep walking
      }
      directory = dirname(directory);
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export const PACKAGE_VERSION = readVersion();
