/**
 * Roadmap #11/#13/#14/#51 (2026-08-07, migration 0045): multi-user firm
 * accounts with roles. Proves the actual permission BOUNDARY from the API
 * -- a Staff session genuinely gets 403'd on a mutating route, not just
 * that a UI button is hidden -- same "spy on the real thing, not the
 * intent" posture demo4-email-lockdown.spec.ts already established.
 *
 * The real invite/accept endpoints don't exist yet (a later commit in
 * this same feature) -- members are seeded directly via store.createFirm-
 * Member()/store.createSession() here, which is the same shape those
 * endpoints will eventually produce.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function seedFirmWithMember(
  role: store.FirmMemberRole,
  opts: { firmName?: string; email?: string } = {}
): Promise<{ firmId: string; memberId: string; cookie: string }> {
  const adminEmail = `firmroles-owner-${Date.now()}-${Math.random()}@example.com`;
  const firm = await store.createFirm(env.DB, { name: opts.firmName ?? "Roles Test Firm", adminEmail });
  let memberId = firm.memberId;
  if (role !== "partner") {
    const email = opts.email ?? `firmroles-${role}-${Date.now()}-${Math.random()}@example.com`;
    const created = await store.createFirmMember(env.DB, {
      firmId: firm.id,
      email,
      name: `Test ${role}`,
      role,
    });
    memberId = created.id;
  }
  const { rawSessionToken } = await store.createSession(env.DB, firm.id, memberId);
  return { firmId: firm.id, memberId, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function addStaffRosterRow(cookie: string): Promise<{ id: string }> {
  const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      staff_label: "Roster Row",
      email: `firmroles-roster-${Date.now()}-${Math.random()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    }),
  });
  expect(resp.status).toBe(201);
  return resp.json();
}

describe("Staff role: read-only on roster/CPE/firm-setting mutations", () => {
  it("cannot create a roster row (403), but CAN read the roster (200)", async () => {
    const partner = await seedFirmWithMember("partner");
    // Staff needs a real roster row to exist to prove reads still work --
    // added by the Partner first, same as a real invited Staff member
    // would see an already-populated roster.
    await addStaffRosterRow(partner.cookie);

    const staff = await store.createFirmMember(env.DB, {
      firmId: partner.firmId,
      email: `firmroles-staff-${Date.now()}@example.com`,
      role: "staff",
    });
    const { rawSessionToken } = await store.createSession(env.DB, partner.firmId, staff.id);
    const staffCookie = `dr_firm_session=${rawSessionToken}`;

    const createResp = await SELF.fetch(`${BASE}/firm/licenses`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: staffCookie },
      body: JSON.stringify({
        staff_label: "Blocked",
        email: `firmroles-blocked-${Date.now()}@example.com`,
        state_slug: "georgia",
        license_type_id: "ga-individual",
      }),
    });
    expect(createResp.status).toBe(403);

    const readResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: staffCookie } });
    expect(readResp.status).toBe(200);
    const body = (await readResp.json()) as { licenses: unknown[] };
    expect(body.licenses.length).toBeGreaterThan(0);
  });

  it("cannot delete a CPE entry, cannot set the firm's peer-review date, cannot set reply-to", async () => {
    const staffSession = await seedFirmWithMember("staff");

    const cpeDelete = await SELF.fetch(`${BASE}/firm/cpe/some-id`, {
      method: "DELETE",
      headers: { Cookie: staffSession.cookie },
    });
    expect(cpeDelete.status).toBe(403);

    const peerReview = await SELF.fetch(`${BASE}/firm/peer-review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: staffSession.cookie },
      body: JSON.stringify({ due_date: "2027-01-01" }),
    });
    expect(peerReview.status).toBe(403);

    const replyTo = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: staffSession.cookie },
      body: JSON.stringify({ email: "reply@example.com" }),
    });
    expect(replyTo.status).toBe(403);
  });

  it("cannot start billing checkout, cannot cancel the subscription, cannot delete the account", async () => {
    const staffSession = await seedFirmWithMember("staff");

    const checkout = await SELF.fetch(`${BASE}/firm/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: staffSession.cookie },
      body: JSON.stringify({ tier: "firm_starter" }),
    });
    expect(checkout.status).toBe(403);

    const cancel = await SELF.fetch(`${BASE}/firm/billing/cancel`, {
      method: "POST",
      headers: { Cookie: staffSession.cookie },
    });
    expect(cancel.status).toBe(403);

    const del = await SELF.fetch(`${BASE}/firm/account/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: staffSession.cookie },
      body: JSON.stringify({}),
    });
    expect(del.status).toBe(403);
  });
});

describe("Office Manager role: full roster/CPE/firm-setting access, no billing/account-delete", () => {
  it("CAN create a roster row and set the firm's reply-to address", async () => {
    const officeManager = await seedFirmWithMember("office_manager");

    const created = await addStaffRosterRow(officeManager.cookie);
    expect(created.id).toBeTruthy();

    const replyTo = await SELF.fetch(`${BASE}/firm/reply-to`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: officeManager.cookie },
      body: JSON.stringify({ email: `officemgr-reply-${Date.now()}@example.com` }),
    });
    expect(replyTo.status).toBe(200);
  });

  it("cannot start billing checkout or delete the account", async () => {
    const officeManager = await seedFirmWithMember("office_manager");

    const checkout = await SELF.fetch(`${BASE}/firm/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: officeManager.cookie },
      body: JSON.stringify({ tier: "firm_starter" }),
    });
    expect(checkout.status).toBe(403);

    const del = await SELF.fetch(`${BASE}/firm/account/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: officeManager.cookie },
      body: JSON.stringify({}),
    });
    expect(del.status).toBe(403);
  });
});

describe("Partner role: unrestricted -- the pre-migration single-admin baseline, unchanged", () => {
  it("can create a roster row and start billing checkout (Stripe error is fine -- the point is it's not a 403)", async () => {
    const partner = await seedFirmWithMember("partner");
    const created = await addStaffRosterRow(partner.cookie);
    expect(created.id).toBeTruthy();

    const checkout = await SELF.fetch(`${BASE}/firm/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: partner.cookie },
      body: JSON.stringify({ tier: "firm_starter" }),
    });
    // No STRIPE_SECRET_KEY in the test env -> 503, not 403. Proves the
    // role check passed and it's Stripe config, not permissions, stopping
    // this request.
    expect(checkout.status).not.toBe(403);
  });
});

// AuditLab ROLE-5 (LOW-MEDIUM, 2026-08-14, Devin's call): GET /firm/audit-trail
// was session-only -- any role including Staff could export the firm's
// full uncapped activity log, with every colleague's email attached.
// Gated to match the dominant partner/office_manager pattern the other 29
// firm-wide handlers already use.
describe("Audit trail (ROLE-5): partner/office_manager only, Staff refused", () => {
  it("Staff gets 403, Office Manager and Partner get 200", async () => {
    const staffSession = await seedFirmWithMember("staff");
    const officeManager = await seedFirmWithMember("office_manager");
    const partner = await seedFirmWithMember("partner");

    const staffResp = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: staffSession.cookie } });
    expect(staffResp.status).toBe(403);

    const omResp = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: officeManager.cookie } });
    expect(omResp.status).toBe(200);

    const partnerResp = await SELF.fetch(`${BASE}/firm/audit-trail`, { headers: { Cookie: partner.cookie } });
    expect(partnerResp.status).toBe(200);
  });
});

// AuditLab ROLE-4 (LOW, 2026-08-14, Devin's call): GET /firm/licenses
// (the roster/dashboard-load response) read cancel_at_period_end/
// current_period_end for every role, while the cancel/resume ACTION
// itself is partner-only. Same shape as ROLE-5, lower stakes (no PII,
// just billing-status booleans/dates) -- gated the read to match the
// action's own partner-only gate rather than the room's role-set.
describe("Billing status fields on GET /firm/licenses (ROLE-4): partner only", () => {
  it("Staff and Office Manager responses omit cancel_at_period_end/current_period_end; Partner's includes them", async () => {
    const staffSession = await seedFirmWithMember("staff");
    const officeManager = await seedFirmWithMember("office_manager");
    const partner = await seedFirmWithMember("partner");

    for (const session of [staffSession, officeManager]) {
      const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: session.cookie } });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expect("cancel_at_period_end" in body).toBe(false);
      expect("current_period_end" in body).toBe(false);
    }

    const partnerResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: partner.cookie } });
    expect(partnerResp.status).toBe(200);
    const partnerBody = (await partnerResp.json()) as Record<string, unknown>;
    expect("cancel_at_period_end" in partnerBody).toBe(true);
    expect("current_period_end" in partnerBody).toBe(true);
  });
});

// ROLE-2 (AuditLab, 2026-08-07, orchestrator-approved 2026-08-21): 6 firm-
// write handlers (NPS response/dismiss, questionnaire submit/dismiss,
// onboarding-checklist dismiss, product-tour dismiss) were session-only,
// no role check -- a Staff account could burn the firm's NPS cooldown,
// answer/dismiss the onboarding questionnaire, or permanently suppress the
// Partner's own onboarding checklist/product tour (all firm-wide flags,
// not per-member), none of which the UI offers Staff. Same partner/
// office_manager split as every other firm-write endpoint. Proves the
// real API boundary, not just that a UI button is hidden -- this file's
// own stated purpose.
describe("Onboarding/engagement writes (ROLE-2): partner/office_manager only, Staff refused", () => {
  it("Staff gets 403 on all 6 writes; Office Manager and Partner get through", async () => {
    const staffSession = await seedFirmWithMember("staff");
    const officeManager = await seedFirmWithMember("office_manager");
    const partner = await seedFirmWithMember("partner");

    const routes: { path: string; method: string; body?: Record<string, unknown> }[] = [
      { path: "/firm/nps", method: "POST", body: { score: 8 } },
      { path: "/firm/nps/dismiss", method: "POST" },
      { path: "/firm/questionnaire", method: "POST", body: { selected_features: [] } },
      { path: "/firm/questionnaire/dismiss", method: "POST" },
      { path: "/firm/onboarding-checklist/dismiss", method: "POST" },
      { path: "/firm/product-tour/dismiss", method: "POST" },
    ];

    for (const route of routes) {
      const staffResp = await SELF.fetch(`${BASE}${route.path}`, {
        method: route.method,
        headers: { "content-type": "application/json", Cookie: staffSession.cookie },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      expect(staffResp.status, `${route.path} should 403 a Staff session`).toBe(403);
    }

    // Office Manager and Partner both get PAST the role gate -- asserting
    // "not 403" rather than a specific 2xx, since several of these are
    // idempotent/cooldown-gated and a second identical call from a shared
    // test firm can legitimately no-op without being a role failure.
    for (const session of [officeManager, partner]) {
      for (const route of routes) {
        const resp = await SELF.fetch(`${BASE}${route.path}`, {
          method: route.method,
          headers: { "content-type": "application/json", Cookie: session.cookie },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        expect(resp.status, `${route.path} should not 403 an Office Manager/Partner session`).not.toBe(403);
      }
    }
  });
});
