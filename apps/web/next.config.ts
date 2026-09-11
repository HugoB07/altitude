import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

/**
 * Load the workspace's env file, not this package's.
 *
 * Next looks for .env.local beside the application, which in a monorepo means
 * apps/web/.env.local. drizzle-kit reads the repository root. Left alone, the
 * same secrets would have to exist in two files and would eventually disagree -
 * and the way that failure shows up is a migration applied to one database
 * while the application talks to another.
 *
 * One file at the root, read by both. Node's own loader, so no dotenv
 * dependency, and fileURLToPath rather than URL.pathname, which yields
 * "/C:/..." on Windows.
 *
 * loadEnvFile does not overwrite variables already set, so a real environment
 * still wins over the file - which is what production does.
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
  /**
   * Loaded from `node_modules` by Node itself, never copied into a bundle.
   *
   * pdf.js reaches for files that sit beside it in its own package - its worker
   * and its font data - and a bundler that copies the module without them
   * leaves it reaching into an empty directory. This is the documented remedy
   * for a package that depends on its own layout on disk.
   */
  serverExternalPackages: ['pdfjs-dist'],
  experimental: {
    serverActions: {
      /**
       * A megabyte over `MAX_UPLOAD_BYTES`, which is the number the application
       * states and refuses on.
       *
       * Next caps a server action body at 1MB by default. Left alone it would
       * refuse first, and refuse with a framework error rather than a sentence
       * naming the limit - so the file that a person is told is acceptable has
       * to fit through here, with room for what multipart adds around it.
       */
      bodySizeLimit: '6mb',
    },
  },
};

// next-intl needs the request config wired at build time so server components
// can read messages without a provider above them.
export default createNextIntlPlugin('./src/i18n/request.ts')(nextConfig);
