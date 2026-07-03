import type { NextConfig } from "next";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };

/**
 * Resolve the pi (@piclaw/coding-agent) version.
 *
 * Tries, in order:
 *  1. local web/node_modules/@piclaw/coding-agent/package.json
 *  2. monorepo root node_modules/@piclaw/coding-agent/package.json (workspace symlink)
 *  3. the package directory itself at packages/coding-agent/package.json
 *
 * Falls back to "unknown" only if none of the above exist.
 */
function resolvePiVersion(): string {
  const monoRoot = resolve(__dirname, "..");
  const candidates = [
    join(__dirname, "node_modules/@piclaw/coding-agent/package.json"),
    join(monoRoot, "node_modules/@piclaw/coding-agent/package.json"),
    join(monoRoot, "packages/coding-agent/package.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
      } catch { /* try next candidate */ }
    }
  }
  return "unknown";
}

const piVersion = resolvePiVersion();

const nextConfig: NextConfig = {
  transpilePackages: [
    "@piclaw/ai",
    "@piclaw/agent-core",
    "@piclaw/tui",
  ],
  serverExternalPackages: ["better-sqlite3"],
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
