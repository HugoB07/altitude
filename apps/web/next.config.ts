import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Load the workspace's env file, not this package's.
 *
 * Next looks for .env.local beside the application, which in a monorepo means
 * apps/web/.env.local. drizzle-kit reads the repository root. Left alone, the
 * same secrets would have to exist in two files and would eventually disagree —
 * and the way that failure shows up is a migration applied to one database
 * while the application talks to another.
 *
 * One file at the root, read by both. Node's own loader, so no dotenv
 * dependency, and fileURLToPath rather than URL.pathname, which yields
 * "/C:/..." on Windows.
 *
 * loadEnvFile does not overwrite variables already set, so a real environment
 * still wins over the file — which is what production does.
 */
for (const file of ['../../.env.local', '../../.env']) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript source rather than built output, so
  // Next has to compile them alongside the application.
  transpilePackages: ['@altitude/shared', '@altitude/core', '@altitude/db'],
};

export default nextConfig;
