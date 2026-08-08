/**
 * AuditLab MAP-1 (MEDIUM, 2026-08-07): scope-based mobility-check rate
 * limiting. An Enterprise-tier firm (25 seats -> up to 25 distinct home
 * states) could 429 reviewing its own Map twice in an hour -- the client
 * cache is in-memory and wiped on reload, so "review twice" is ordinary
 * use, not abuse. Devin's decision: a query for a home state the firm
 * actually has staff in is unmetered (bounded by the seat cap already);
 * only a query for a state nobody on the roster is in -- the harvesting
 * shape -- consumes the metered bucket.
 *
 * Split into its own file (not worker.spec.ts, where this was originally
 * written): running these tests as the ~310th-316th of worker.spec.ts's
 * own single file triggered a vitest-pool-workers-internal "Maximum call
 * stack size exceeded" (inside the harness's own test-internal.mjs, not
 * this codebase) that did not reproduce in isolation or here. Matches
 * this session's own established practice of splitting new feature test
 * suites out of that file (firm-roles.spec.ts, firm-members-crud.spec.ts).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function firmOnTier(tier: string, createdAt: string): Promise<{ firmId: string; cookie: string }> {
  const { id } = await store.createFirm(env.DB, {
    name: `MAP-1 ${tier} Firm`,
    adminEmail: `map1-${tier}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
  });
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1, created_at = ?2 WHERE id = ?3")
    .bind(tier, createdAt, id)
    .run();
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { firmId: id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function postMobilityCheckBatch(body: Record<string, unknown>, cookie: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/mobility/check-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/** Georgia (fixed_calendar renewal) needs no birth-month fields, matching
 * the established roster-seed pattern elsewhere in this suite. */
async function addGeorgiaRosterRow(cookie: string, label: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      staff_label: label,
      email: `map1-roster-${Date.now()}-${Math.random()}@examplefirm.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    }),
  });
}

const VALID_BATCH_CHECK = {
  home_state_slug: "georgia",
  service_type: "tax",
  license_in_good_standing: true,
  substantially_equivalent: true,
};

describe("POST /firm/mobility/check-batch -- MAP-1 scope-based rate limiting", () => {
  // Same metered ceiling the pre-existing test already covered, just
  // relocated here alongside its sibling scope-decision tests. A firm
  // with an EMPTY roster (no staff added, as here) has no unmetered
  // states -- every query is metered, per the spec's own documented edge
  // case (a brand-new trial firm's first exploration is fully metered).
  it("blocks the 121st batch call from the same firm within the hour when the state queried is NOT on the roster", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    let sawA429 = false;
    for (let i = 0; i < 125; i++) {
      const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie, `203.0.113.${100 + i}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429, "expected a 429 within the RATE_LIMIT_MOBILITY_CHECK_BATCH ceiling (120/hour) -- got none in 125 requests").toBe(true);
  }, 60000);

  it("MAP-1: querying the firm's OWN roster home state is unmetered -- never 429s even past the old 40/hour ceiling", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const rosterAdd = await addGeorgiaRosterRow(cookie, "MAP-1 roster row");
    expect(rosterAdd.status).toBe(201);
    for (let i = 0; i < 55; i++) {
      const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie, `203.0.113.${150 + i}`);
      expect(resp.status).toBe(200);
    }
  }, 60000);

  it("MAP-1: a state NOT on the firm's roster still consumes the metered bucket even while its own-roster queries stay free", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const rosterAdd = await addGeorgiaRosterRow(cookie, "MAP-1 mixed roster row");
    expect(rosterAdd.status).toBe(201);
    // Off-roster queries (Texas) consume the metered bucket and 429 at
    // its ceiling...
    let sawA429 = false;
    for (let i = 0; i < 125; i++) {
      const resp = await postMobilityCheckBatch({ ...VALID_BATCH_CHECK, home_state_slug: "texas" }, cookie, `203.0.113.${180 + i}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429).toBe(true);
    // ...but the SAME firm's own-roster queries (Georgia) are on a
    // completely separate bucket and are unaffected.
    const ownRoster = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie, "203.0.113.240");
    expect(ownRoster.status).toBe(200);
  }, 60000);

  it("empty roster edge case is deliberate: a brand-new trial firm's first exploration is fully metered (documented, not an oversight)", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    // No roster at all -- every state is "off-roster," so this firm's
    // very first Map click is on the metered path. Confirms the request
    // still succeeds (just metered, not blocked outright).
    const resp = await postMobilityCheckBatch(VALID_BATCH_CHECK, cookie, "203.0.113.241");
    expect(resp.status).toBe(200);
  });
});
