/**
 * Roadmap #320 (2026-08-10): "Batch Practice Privilege Check" -- the WHOLE
 * ROSTER against ONE target state, the orthogonal axis from
 * handleMobilityCheckBatch() (map1-mobility-scope.spec.ts /
 * worker.spec.ts's own check-batch describe block), which fans ONE person
 * across every target state. Split into its own file rather than added to
 * worker.spec.ts, matching the established practice for new mobility
 * feature suites (map1-mobility-scope.spec.ts's own docstring: that file
 * split out after a vitest-pool-workers-internal stack-overflow was seen
 * growing worker.spec.ts further).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function firmOnTier(tier: string, createdAt: string): Promise<{ firmId: string; cookie: string }> {
  const { id } = await store.createFirm(env.DB, {
    name: `Roster-Check ${tier} Firm`,
    adminEmail: `roster-check-${tier}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
  });
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1, created_at = ?2 WHERE id = ?3")
    .bind(tier, createdAt, id)
    .run();
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { firmId: id, cookie: `dr_firm_session=${rawSessionToken}` };
}

/** Same "genuinely multi-person, not just solo-free" concern
 * worker.spec.ts's own addSecondMember() documents -- solo-free firms get
 * unmetered access via a separate branch (mobilityAccessBasis
 * "solo_free"), so a test proving the multi-person free tier itself is
 * blocked needs a real second member. */
async function addSecondMember(firmId: string): Promise<void> {
  await store.createFirmMember(env.DB, {
    firmId,
    email: `roster-check-second-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
    role: "staff",
    alreadyJoined: true,
  });
}

/** Georgia (fixed_calendar renewal) needs no birth-month fields -- same
 * roster-seed convention map1-mobility-scope.spec.ts already established. */
async function addRosterRow(cookie: string, label: string, stateSlug: string, licenseTypeId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      staff_label: label,
      email: `roster-check-row-${Date.now()}-${Math.random()}@examplefirm.com`,
      state_slug: stateSlug,
      license_type_id: licenseTypeId,
    }),
  });
}

async function postCheckRoster(body: Record<string, unknown>, cookie: string | null, ip = "203.0.113.230"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/firm/mobility/check-roster`, { method: "POST", headers, body: JSON.stringify(body) });
}

const VALID_ROSTER_CHECK = { target_state_slug: "texas", service_type: "tax" };

describe("POST /firm/mobility/check-roster -- roadmap #320", () => {
  it("requires a session", async () => {
    expect((await postCheckRoster(VALID_ROSTER_CHECK, null)).status).toBe(401);
  });

  it("blocks a multi-person FREE-tier firm -- deliberately NO trial access to a whole-roster batch (unlike the single check's #153 trial)", async () => {
    const { firmId, cookie } = await firmOnTier("free", new Date().toISOString());
    await addSecondMember(firmId);
    const resp = await postCheckRoster(VALID_ROSTER_CHECK, cookie);
    expect(resp.status).toBe(403);
    const body = await resp.json<{ reason: string }>();
    expect(body.reason).toBe("tier_not_paid");
  });

  it("a solo free-tier firm gets access (same solo_free exception every other mobility route already has)", async () => {
    const { cookie } = await firmOnTier("free", new Date().toISOString());
    const resp = await postCheckRoster(VALID_ROSTER_CHECK, cookie);
    expect(resp.status).toBe(200);
  });

  it("a paid firm with an empty roster gets an empty result set, not an error", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postCheckRoster(VALID_ROSTER_CHECK, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ results: unknown[] }>();
    expect(body.results).toEqual([]);
  });

  it("runs every roster row's OWN home state against the one target state, with staff labels and assumed-attestation disclosed", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const addA = await addRosterRow(cookie, "Alex Roster", "georgia", "ga-individual");
    expect(addA.status).toBe(201);
    const addB = await addRosterRow(cookie, "Bailey Roster", "georgia", "ga-individual");
    expect(addB.status).toBe(201);

    const resp = await postCheckRoster({ target_state_slug: "texas", service_type: "tax" }, cookie);
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      target_state: string;
      assumed_license_good_standing: boolean;
      assumed_substantially_equivalent: boolean;
      results: { staff_label: string; home_state_slug: string; overall: string }[];
    }>();
    expect(body.target_state).toBe("Texas");
    expect(body.assumed_license_good_standing).toBe(true);
    expect(body.assumed_substantially_equivalent).toBe(true);
    expect(body.results.length).toBe(2);
    const labels = body.results.map((r) => r.staff_label).sort();
    expect(labels).toEqual(["Alex Roster", "Bailey Roster"]);
    for (const r of body.results) {
      expect(r.home_state_slug).toBe("georgia");
      expect(typeof r.overall).toBe("string");
    }
  });

  it("rejects an unknown target state as a 400", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postCheckRoster({ target_state_slug: "atlantis", service_type: "tax" }, cookie);
    expect(resp.status).toBe(400);
  });

  it("rejects an invalid service type", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    const resp = await postCheckRoster({ target_state_slug: "texas", service_type: "audit" }, cookie);
    expect(resp.status).toBe(400);
  });

  it("blocks the 121st call from the same firm within the hour -- own dedicated bucket, not shared with check/check-batch", async () => {
    const { cookie } = await firmOnTier("firm", new Date().toISOString());
    let sawA429 = false;
    for (let i = 0; i < 125; i++) {
      const resp = await postCheckRoster(VALID_ROSTER_CHECK, cookie, `203.0.113.${100 + i}`);
      if (resp.status === 429) {
        sawA429 = true;
        break;
      }
      expect(resp.status).toBe(200);
    }
    expect(sawA429, "expected a 429 within RATE_LIMIT_MOBILITY_CHECK_ROSTER's ceiling (120/hour) -- got none in 125 requests").toBe(true);
  }, 60000);
});
