/**
 * Endpoint-level tests for roadmap #318's firm-level registration check --
 * pay-gate, rate-limit bucket isolation from the individual check, and the
 * server-side peer-review-date read. The determination logic itself is
 * covered in firm-mobility.spec.ts/firm-mobility-data.spec.ts; these attack
 * the HTTP layer only, same split as worker.spec.ts's own mobility section.
 */
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function firmOnTier(tier: string, peerReviewDueDate: string | null = null): Promise<{ firmId: string; cookie: string }> {
  const { id } = await store.createFirm(env.DB, {
    name: `Firm Mobility ${tier} Firm`,
    adminEmail: `firmmobility-${tier}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
  });
  await env.DB.prepare("UPDATE firms SET plan_tier = ?1 WHERE id = ?2").bind(tier, id).run();
  if (peerReviewDueDate) {
    await env.DB.prepare("UPDATE firms SET peer_review_due_date = ?1 WHERE id = ?2").bind(peerReviewDueDate, id).run();
  }
  const { rawSessionToken } = await store.createSession(env.DB, id);
  return { firmId: id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function postFirmCheck(body: Record<string, unknown>, cookie: string | null, ip = "203.0.113.240"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/firm/mobility/firm-check`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** store.createFirm() always creates exactly one firm_member, so a bare
 * firmOnTier("free") firm is a genuinely solo account and now legitimately
 * gets paid-feature access (2026-08-09 individual-tier fold -- see
 * individual-tier-fold.spec.ts for that exception's own dedicated tests).
 * Tests here whose intent is the general "free tier is blocked" rule need
 * a second member to still exercise that path. */
async function addSecondMember(firmId: string): Promise<void> {
  await store.createFirmMember(env.DB, {
    firmId,
    email: `firmmobility-second-${Date.now()}-${Math.floor(Math.random() * 1e6)}@examplefirm.com`,
    role: "staff",
    alreadyJoined: true,
  });
}

const VALID_CHECK = { firm_home_state_slug: "california", target_state_slug: "texas", has_physical_office: false };

describe("POST /firm/mobility/firm-check -- pay gate", () => {
  it("requires a session", async () => {
    expect((await postFirmCheck(VALID_CHECK, null)).status).toBe(401);
  });

  it("BLOCKS a multi-person free-tier firm", async () => {
    const { firmId, cookie } = await firmOnTier("free");
    await addSecondMember(firmId);
    expect((await postFirmCheck(VALID_CHECK, cookie)).status).toBe(403);
  });

  it("ALLOWS a genuinely solo (1-member) free-tier firm -- the 2026-08-09 individual-tier-fold exception", async () => {
    const { cookie } = await firmOnTier("free");
    expect((await postFirmCheck(VALID_CHECK, cookie)).status).toBe(200);
  });

  it("BLOCKS an unrecognised tier -- the gate fails closed", async () => {
    const { cookie } = await firmOnTier("enterprise_typo");
    expect((await postFirmCheck(VALID_CHECK, cookie)).status).toBe(403);
  });

  it("allows a paid tier", async () => {
    const { cookie } = await firmOnTier("firm");
    expect((await postFirmCheck(VALID_CHECK, cookie)).status).toBe(200);
  });

  it("gates the firm-coverage endpoint too, same as the individual coverage endpoint, for a multi-person free firm", async () => {
    const { firmId, cookie } = await firmOnTier("free");
    await addSecondMember(firmId);
    const resp = await SELF.fetch(`${BASE}/firm/mobility/firm-coverage`, {
      headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.241" },
    });
    expect(resp.status).toBe(403);
  });

  it("400s on an unrecognised state slug -- never a silent lookup miss", async () => {
    const { cookie } = await firmOnTier("firm");
    const resp = await postFirmCheck({ ...VALID_CHECK, target_state_slug: "atlantis" }, cookie);
    expect(resp.status).toBe(400);
  });
});

describe("POST /firm/mobility/firm-check -- server-side peer-review read", () => {
  it("uses the FIRM'S OWN stored peer_review_due_date, not a client-supplied one", async () => {
    // Kansas: attest_exemption + peer_review_conditions_permit both true,
    // no source disagreement -- a clean peer-review-conditional fixture.
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const { cookie } = await firmOnTier("firm", null); // no due date on file
    const resp = await postFirmCheck(
      {
        firm_home_state_slug: "california",
        target_state_slug: "kansas",
        has_physical_office: false,
        // Attacker-supplied field the endpoint must never read.
        firm_peer_review_due_date: future,
      },
      cookie
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { verdict: string };
    // If the client-supplied date were honoured, this would be "clear".
    // The firm's REAL on-file date is null, so it must be action_required.
    expect(body.verdict).toBe("action_required");
  });

  it("reflects a real, current on-file peer-review due date as clear", async () => {
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const { cookie } = await firmOnTier("firm", future);
    const resp = await postFirmCheck(
      { firm_home_state_slug: "california", target_state_slug: "kansas", has_physical_office: false },
      cookie
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { verdict: string };
    expect(body.verdict).toBe("clear");
  });
});

describe("rate-limit bucket isolation from the individual mobility check", () => {
  it("firm-check and individual check are tracked under different bucket names", async () => {
    const { cookie } = await firmOnTier("firm");
    await postFirmCheck(VALID_CHECK, cookie, "203.0.113.242");
    await SELF.fetch(`${BASE}/firm/mobility/check`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie, "cf-connecting-ip": "203.0.113.242" },
      body: JSON.stringify({
        home_state_slug: "california",
        target_state_slug: "texas",
        service_type: "tax",
        license_in_good_standing: true,
        substantially_equivalent: true,
      }),
    });
    const firmBucket = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limit_hits WHERE bucket = 'firm_mobility_check'").first<{ c: number }>();
    const individualBucket = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limit_hits WHERE bucket = 'mobility_check'").first<{ c: number }>();
    expect(firmBucket?.c ?? 0).toBeGreaterThan(0);
    expect(individualBucket?.c ?? 0).toBeGreaterThan(0);
  });
});
