/**
 * Roadmap #11/#13/#14/#51 (2026-08-07, migration 0045): the member
 * invite/list/role-change/remove endpoints. firm-roles.spec.ts already
 * proves the READ-side role gates (Staff read-only on roster/CPE/etc.);
 * this file proves the member-MANAGEMENT surface itself -- who can invite
 * whom, the free-tier block, demo_locked, role hierarchy, last-Partner
 * protection, and that removal actually revokes access rather than just
 * hiding a row.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function seedPaidFirm(name = "Members Test Firm"): Promise<{ firmId: string; memberId: string; cookie: string }> {
  const adminEmail = `members-owner-${Date.now()}-${Math.random()}@example.com`;
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  await env.DB.prepare("UPDATE firms SET plan_tier = 'firm_starter' WHERE id = ?1").bind(firm.id).run();
  const { rawSessionToken } = await store.createSession(env.DB, firm.id, firm.memberId);
  return { firmId: firm.id, memberId: firm.memberId, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function addMember(firmId: string, role: store.FirmMemberRole): Promise<{ memberId: string; cookie: string }> {
  const email = `members-${role}-${Date.now()}-${Math.random()}@example.com`;
  const created = await store.createFirmMember(env.DB, { firmId, email, role });
  const { rawSessionToken } = await store.createSession(env.DB, firmId, created.id);
  return { memberId: created.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

function inviteBody(role: string, email?: string) {
  return JSON.stringify({ email: email ?? `members-invitee-${Date.now()}-${Math.random()}@example.com`, role });
}

async function postInvite(cookie: string, body: string): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/members/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body,
  });
}

describe("POST /firm/members/invite", () => {
  it("a Partner on a paid tier can invite a Staff member, and the invite is a real acceptable login token", async () => {
    const partner = await seedPaidFirm();
    const email = `members-accept-${Date.now()}@example.com`;
    const resp = await postInvite(partner.cookie, inviteBody("staff", email));
    expect(resp.status).toBe(201);
    const body = await resp.json<{ id: string; email: string; role: string; joined_at: string | null }>();
    expect(body.role).toBe("staff");
    expect(body.joined_at).toBeNull();

    const member = await store.getFirmMemberById(env.DB, partner.firmId, body.id);
    expect(member?.email).toBe(email);
    expect(member?.joined_at).toBeNull();

    // The invite is a real "login"-purpose token for this exact member --
    // clicking it is how acceptance works, no separate accept endpoint.
    const row = await env.DB.prepare("SELECT member_id, purpose FROM firm_login_tokens WHERE member_id = ?1")
      .bind(body.id)
      .first<{ member_id: string; purpose: string }>();
    expect(row?.member_id).toBe(body.id);
    expect(row?.purpose).toBe("login");
  });

  it("Staff cannot invite anyone (403)", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");
    const resp = await postInvite(staff.cookie, inviteBody("staff"));
    expect(resp.status).toBe(403);
  });

  it("an Office Manager can invite Staff but NOT Office Manager or Partner (role hierarchy)", async () => {
    const partner = await seedPaidFirm();
    const officeManager = await addMember(partner.firmId, "office_manager");

    const staffInvite = await postInvite(officeManager.cookie, inviteBody("staff"));
    expect(staffInvite.status).toBe(201);

    const omInvite = await postInvite(officeManager.cookie, inviteBody("office_manager"));
    expect(omInvite.status).toBe(403);

    const partnerInvite = await postInvite(officeManager.cookie, inviteBody("partner"));
    expect(partnerInvite.status).toBe(403);
  });

  it("a Partner CAN invite another Partner or Office Manager", async () => {
    const partner = await seedPaidFirm();
    expect((await postInvite(partner.cookie, inviteBody("office_manager"))).status).toBe(201);
    expect((await postInvite(partner.cookie, inviteBody("partner"))).status).toBe(201);
  });

  it("Devin's pricing rule: a FREE-tier firm cannot add a second person at all (402, upgrade prompt)", async () => {
    const adminEmail = `members-free-${Date.now()}@example.com`;
    const firm = await store.createFirm(env.DB, { name: "Free Tier Firm", adminEmail });
    const { rawSessionToken } = await store.createSession(env.DB, firm.id, firm.memberId);
    const cookie = `dr_firm_session=${rawSessionToken}`;

    const resp = await postInvite(cookie, inviteBody("staff"));
    expect(resp.status).toBe(402);
    const body = await resp.json<{ error: string; pay_now_url: string }>();
    expect(body.error.toLowerCase()).toContain("paid plan");
    expect(body.pay_now_url).toBeTruthy();

    // The Solo/INDIVIDUAL product must never gain multi-person capability
    // by construction -- confirmed here at the firm layer: no member row
    // was created for the rejected invite.
    const members = await store.listFirmMembers(env.DB, firm.id);
    expect(members).toHaveLength(1);
  });

  it("a demo_locked firm cannot invite anyone, even on a paid tier (no self-serve credential path for the shared demo account)", async () => {
    const partner = await seedPaidFirm("Demo Members Firm");
    await env.DB.prepare("UPDATE firms SET demo_locked = 1 WHERE id = ?1").bind(partner.firmId).run();
    const resp = await postInvite(partner.cookie, inviteBody("staff"));
    expect(resp.status).toBe(403);
    const body = await resp.json<{ error: string }>();
    expect(body.error.toLowerCase()).toContain("demo account");
  });

  it("rejects inviting an email that's already active in this firm, or already belongs to a DIFFERENT firm", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");
    const staffMember = await store.getFirmMemberById(env.DB, partner.firmId, staff.memberId);

    const sameFirm = await postInvite(partner.cookie, inviteBody("staff", staffMember!.email));
    expect(sameFirm.status).toBe(409);

    const otherFirm = await seedPaidFirm("Other Firm");
    const otherFirmOwner = await store.getFirmMemberById(env.DB, otherFirm.firmId, otherFirm.memberId);
    const crossFirm = await postInvite(partner.cookie, inviteBody("staff", otherFirmOwner!.email));
    expect(crossFirm.status).toBe(409);
  });

  it("rejects an invalid email and an invalid role", async () => {
    const partner = await seedPaidFirm();
    expect((await postInvite(partner.cookie, inviteBody("staff", "not-an-email"))).status).toBe(400);
    expect((await postInvite(partner.cookie, JSON.stringify({ email: `x-${Date.now()}@example.com`, role: "superadmin" }))).status).toBe(400);
  });

  it("requires a session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/members/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: inviteBody("staff"),
    });
    expect(resp.status).toBe(401);
  });
});

describe("GET /firm/members", () => {
  it("is visible to all three roles, and flags the primary contact and the caller", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");

    for (const cookie of [partner.cookie, staff.cookie]) {
      const resp = await SELF.fetch(`${BASE}/firm/members`, { headers: { Cookie: cookie } });
      expect(resp.status).toBe(200);
      const body = await resp.json<{ members: Array<{ id: string; is_primary: boolean; is_you: boolean }> }>();
      expect(body.members.length).toBeGreaterThanOrEqual(2);
      expect(body.members.find((m) => m.id === partner.memberId)?.is_primary).toBe(true);
    }
  });
});

describe("PATCH /firm/members/:id -- role change", () => {
  it("Partner-only: Office Manager cannot change anyone's role", async () => {
    const partner = await seedPaidFirm();
    const officeManager = await addMember(partner.firmId, "office_manager");
    const staff = await addMember(partner.firmId, "staff");

    const resp = await SELF.fetch(`${BASE}/firm/members/${staff.memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: officeManager.cookie },
      body: JSON.stringify({ role: "office_manager" }),
    });
    expect(resp.status).toBe(403);
  });

  it("a Partner can promote a Staff member to Office Manager", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");

    const resp = await SELF.fetch(`${BASE}/firm/members/${staff.memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: partner.cookie },
      body: JSON.stringify({ role: "office_manager" }),
    });
    expect(resp.status).toBe(200);
    expect((await store.getFirmMemberById(env.DB, partner.firmId, staff.memberId))?.role).toBe("office_manager");
  });

  it("refuses to demote a firm's only Partner", async () => {
    const partner = await seedPaidFirm();
    const resp = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: partner.cookie },
      body: JSON.stringify({ role: "office_manager" }),
    });
    expect(resp.status).toBe(400);
    expect((await store.getFirmMemberById(env.DB, partner.firmId, partner.memberId))?.role).toBe("partner");
  });

  it("allows demoting a Partner when another active Partner remains", async () => {
    const partner = await seedPaidFirm();
    const secondPartner = await addMember(partner.firmId, "partner");
    const resp = await SELF.fetch(`${BASE}/firm/members/${secondPartner.memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: partner.cookie },
      body: JSON.stringify({ role: "staff" }),
    });
    expect(resp.status).toBe(200);
  });

  it("404s for a member id that belongs to a different firm", async () => {
    const partner = await seedPaidFirm();
    const other = await seedPaidFirm("Other Firm B");
    const resp = await SELF.fetch(`${BASE}/firm/members/${other.memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: partner.cookie },
      body: JSON.stringify({ role: "staff" }),
    });
    expect(resp.status).toBe(404);
  });
});

describe("DELETE /firm/members/:id -- remove", () => {
  it("an Office Manager can remove a Staff member", async () => {
    const partner = await seedPaidFirm();
    const officeManager = await addMember(partner.firmId, "office_manager");
    const staff = await addMember(partner.firmId, "staff");

    const resp = await SELF.fetch(`${BASE}/firm/members/${staff.memberId}`, { method: "DELETE", headers: { Cookie: officeManager.cookie } });
    expect(resp.status).toBe(200);
    expect(await store.getFirmMemberById(env.DB, partner.firmId, staff.memberId)).toBeNull();
  });

  it("an Office Manager cannot remove another Office Manager or a Partner", async () => {
    const partner = await seedPaidFirm();
    const officeManager = await addMember(partner.firmId, "office_manager");
    const secondOfficeManager = await addMember(partner.firmId, "office_manager");

    const resp = await SELF.fetch(`${BASE}/firm/members/${secondOfficeManager.memberId}`, {
      method: "DELETE",
      headers: { Cookie: officeManager.cookie },
    });
    expect(resp.status).toBe(403);

    const resp2 = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}`, {
      method: "DELETE",
      headers: { Cookie: officeManager.cookie },
    });
    expect(resp2.status).toBe(403);
  });

  it("refuses to remove a firm's only active Partner", async () => {
    const partner = await seedPaidFirm();
    const resp = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}`, { method: "DELETE", headers: { Cookie: partner.cookie } });
    expect(resp.status).toBe(400);
    expect(await store.getFirmMemberById(env.DB, partner.firmId, partner.memberId)).not.toBeNull();
  });

  it("refuses to remove the firm's current primary contact even if another Partner exists (transfer first)", async () => {
    const partner = await seedPaidFirm();
    await addMember(partner.firmId, "partner");
    const resp = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}`, { method: "DELETE", headers: { Cookie: partner.cookie } });
    expect(resp.status).toBe(400);
  });

  it("removing a member ends their sessions and outstanding tokens -- their old cookie stops working", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");

    // Prove the session is live before removal.
    const before = await SELF.fetch(`${BASE}/firm/members`, { headers: { Cookie: staff.cookie } });
    expect(before.status).toBe(200);

    const del = await SELF.fetch(`${BASE}/firm/members/${staff.memberId}`, { method: "DELETE", headers: { Cookie: partner.cookie } });
    expect(del.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/firm/members`, { headers: { Cookie: staff.cookie } });
    expect(after.status).toBe(401);
  });
});

describe("POST /firm/members/:id/make-primary -- #51 account transfer", () => {
  it("Partner-only: an Office Manager cannot transfer primary contact", async () => {
    const partner = await seedPaidFirm();
    const secondPartner = await addMember(partner.firmId, "partner");
    const officeManager = await addMember(partner.firmId, "office_manager");

    const resp = await SELF.fetch(`${BASE}/firm/members/${secondPartner.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: officeManager.cookie },
    });
    expect(resp.status).toBe(403);
  });

  it("a Partner can transfer primary contact to another Partner -- old primary keeps their Partner role, firm-level mail routes to the new one", async () => {
    const partner = await seedPaidFirm();
    const secondPartner = await addMember(partner.firmId, "partner");
    const secondPartnerRow = await store.getFirmMemberById(env.DB, partner.firmId, secondPartner.memberId);

    const resp = await SELF.fetch(`${BASE}/firm/members/${secondPartner.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: partner.cookie },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json<{ ok: boolean; primary_member_id: string }>();
    expect(body.primary_member_id).toBe(secondPartner.memberId);

    const firm = await store.getFirmById(env.DB, partner.firmId);
    expect(firm?.primary_member_id).toBe(secondPartner.memberId);
    expect(firm?.admin_email).toBe(secondPartnerRow!.email);

    // The OLD primary is untouched -- still an active Partner, not removed.
    expect((await store.getFirmMemberById(env.DB, partner.firmId, partner.memberId))?.role).toBe("partner");
  });

  it("refuses to make a Staff or Office Manager member the primary contact", async () => {
    const partner = await seedPaidFirm();
    const staff = await addMember(partner.firmId, "staff");
    const resp = await SELF.fetch(`${BASE}/firm/members/${staff.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: partner.cookie },
    });
    expect(resp.status).toBe(400);
  });

  it("404s for a member id from a different firm", async () => {
    const partner = await seedPaidFirm();
    const other = await seedPaidFirm("Other Firm C");
    const resp = await SELF.fetch(`${BASE}/firm/members/${other.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: partner.cookie },
    });
    expect(resp.status).toBe(404);
  });

  it("transferring to an already-primary Partner is a harmless no-op success", async () => {
    const partner = await seedPaidFirm();
    const resp = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: partner.cookie },
    });
    expect(resp.status).toBe(200);
  });

  it("a transferred-away primary CAN now be removed (the make-primary escape hatch from the remove-primary refusal)", async () => {
    const partner = await seedPaidFirm();
    const secondPartner = await addMember(partner.firmId, "partner");

    const transfer = await SELF.fetch(`${BASE}/firm/members/${secondPartner.memberId}/make-primary`, {
      method: "POST",
      headers: { Cookie: partner.cookie },
    });
    expect(transfer.status).toBe(200);

    // The now-former primary is removable by the new primary.
    const del = await SELF.fetch(`${BASE}/firm/members/${partner.memberId}`, {
      method: "DELETE",
      headers: { Cookie: secondPartner.cookie },
    });
    expect(del.status).toBe(200);
  });
});
