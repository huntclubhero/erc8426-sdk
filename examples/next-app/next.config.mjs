import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Inside the monorepo, trace files from its root, where the workspace
  // packages live. A standalone copy (packages from npm) traces from here.
  outputFileTracingRoot: existsSync(join(here, "../../pnpm-workspace.yaml")) ? join(here, "../..") : here,
  // passkit-generator reads its own files at runtime, so it stays a plain
  // Node require instead of being bundled.
  serverExternalPackages: ["passkit-generator"],
  // The monorepo has no ESLint config; type checking still runs on build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
