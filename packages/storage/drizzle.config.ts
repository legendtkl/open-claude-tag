import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/env.ts';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveDatabaseUrl({ importMetaUrl: import.meta.url }),
  },
});
