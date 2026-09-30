import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Trace files from the monorepo root, where the workspace packages live.
  outputFileTracingRoot: join(here, "../.."),
  // passkit-generator reads its own files at runtime, so it stays a plain
  // Node require instead of being bundled.
  serverExternalPackages: ["passkit-generator"],
  // The monorepo has no ESLint config; type checking still runs on build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
