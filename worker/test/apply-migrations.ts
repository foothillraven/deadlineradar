import { applyD1Migrations, env } from "cloudflare:test";

// Runs the same migrations/*.sql files a real `wrangler d1 migrations
// apply` would, against Miniflare's local D1 emulation -- so every test
// runs against the identical schema Phase 1 will actually deploy, not a
// hand-maintained test-only schema that could drift from it.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
