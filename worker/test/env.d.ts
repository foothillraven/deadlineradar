/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Mirrors what `wrangler types` would generate from wrangler.toml's
// [[d1_databases]] binding, plus the TEST_MIGRATIONS binding vitest.config.ts
// injects (see readD1Migrations() there) -- hand-written here rather than
// wrangler-generated since Phase 1 has not run `wrangler types` (no real D1
// database exists yet to generate against; the binding NAME is fixed by
// wrangler.toml regardless of whether the target database is real or local).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TURNSTILE_SECRET_KEY?: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
