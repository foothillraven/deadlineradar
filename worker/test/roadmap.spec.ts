/**
 * Task #19 (2026-08-06, migration 0029): post-signup feature-request
 * questionnaire (private, per-firm) + the public /roadmap/ voting page.
 * See that migration's own docstring for the full design reasoning:
 * anonymous cookie-based voting, a separate confirm-clicked "notify me
 * when this ships" opt-in, an operator-curated idea list.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";
const SEEDED_IDEA_ID = "idea-sms-reminders";

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

function okResponse(): Response {
  return new Response("{}", { status: 202 });
}

function cookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

describe("GET /roadmap-data", () => {
  it("lists the seeded ideas with zero votes and voted_by_me:false for a fresh visitor", async () => {
    const resp = await SELF.fetch(`${BASE}/roadmap-data`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ideas: { id: string; vote_count: number; voted_by_me: boolean; status: string }[] };
    const idea = body.ideas.find((i) => i.id === SEEDED_IDEA_ID);
    expect(idea).toBeTruthy();
    expect(idea!.voted_by_me).toBe(false);
    expect(idea!.status).toBe("open");
  });
});

describe("POST /roadmap/vote", () => {
  it("records a vote, mints a voter cookie, and reflects voted_by_me:true on that browser", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/roadmap/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ idea_id: SEEDED_IDEA_ID }),
      })
    );
    expect(resp.status).toBe(200);
    const setCookie = resp.headers.get("set-cookie");
    const voterId = cookieValue(setCookie, "dr_roadmap_voter");
    expect(voterId).toBeTruthy();

    const dataResp = await SELF.fetch(`${BASE}/roadmap-data`, { headers: { Cookie: `dr_roadmap_voter=${voterId}` } });
    const body = (await dataResp.json()) as { ideas: { id: string; voted_by_me: boolean }[] };
    expect(body.ideas.find((i) => i.id === SEEDED_IDEA_ID)!.voted_by_me).toBe(true);
  });

  it("does not double-count a repeat vote from the same voter cookie", async () => {
    const ideaId = "idea-api-access";
    const first = await workerFetch(
      new Request(`${BASE}/roadmap/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
        body: JSON.stringify({ idea_id: ideaId }),
      })
    );
    const voterId = cookieValue(first.headers.get("set-cookie"), "dr_roadmap_voter");
    const firstBody = (await first.json()) as { vote_count: number };

    const second = await workerFetch(
      new Request(`${BASE}/roadmap/vote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.11",
          Cookie: `dr_roadmap_voter=${voterId}`,
        },
        body: JSON.stringify({ idea_id: ideaId }),
      })
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { vote_count: number };
    expect(secondBody.vote_count).toBe(firstBody.vote_count);
  });

  it("404s for an unknown idea_id", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/roadmap/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.12" },
        body: JSON.stringify({ idea_id: "not-a-real-idea" }),
      })
    );
    expect(resp.status).toBe(404);
  });
});

describe("POST /roadmap/notify-signup + GET/POST /roadmap/notify-confirm", () => {
  it("sends a real confirm email and stores an unconfirmed row", async () => {
    const email = `roadmapnotify-${Date.now()}@example.com`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
    try {
      const signupResp = await workerFetch(
        new Request(`${BASE}/roadmap/notify-signup`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
          body: JSON.stringify({ idea_id: SEEDED_IDEA_ID, email }),
        }),
        { SENDGRID_API_KEY: "test-key-not-real" }
      );
      expect(signupResp.status).toBe(200);
      const signupBody = (await signupResp.json()) as { ok: boolean; sent: boolean };
      expect(signupBody.sent).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, sendGridCallInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(String(sendGridCallInit.body));
      expect(sentBody.personalizations[0].to[0].email).toBe(email);

      const row = await env.DB.prepare(
        "SELECT confirmed_at, confirm_token FROM feature_idea_notify_signups WHERE idea_id = ?1 AND email = ?2"
      )
        .bind(SEEDED_IDEA_ID, email.toLowerCase())
        .first<{ confirmed_at: string | null; confirm_token: string | null }>();
      expect(row?.confirmed_at).toBeNull();
      expect(row?.confirm_token).toBeTruthy();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("confirms a real signup end-to-end through the actual HTTP action route", async () => {
    const email = `roadmapconfirm-${Date.now()}@example.com`;
    const signup = await store.createFeatureIdeaNotifySignup(env.DB, SEEDED_IDEA_ID, email);
    expect(signup).toBeTruthy();

    const page = await SELF.fetch(`${BASE}/roadmap/notify-confirm?token=${encodeURIComponent(signup!.rawToken)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

    const confirmResp = await SELF.fetch(`${BASE}/roadmap/notify-confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: signup!.rawToken, action_csrf: nonce }).toString(),
    });
    expect(confirmResp.status).toBe(200);

    const row = await env.DB.prepare("SELECT confirmed_at FROM feature_idea_notify_signups WHERE idea_id = ?1 AND email = ?2")
      .bind(SEEDED_IDEA_ID, email.toLowerCase())
      .first<{ confirmed_at: string | null }>();
    expect(row?.confirmed_at).toBeTruthy();
  });

  it("404s for an unknown/already-used token", async () => {
    const page = await SELF.fetch(`${BASE}/roadmap/notify-confirm?token=not-a-real-token`);
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const resp = await SELF.fetch(`${BASE}/roadmap/notify-confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-real-token", action_csrf: nonce }).toString(),
    });
    expect(resp.status).toBe(404);
  });
});

describe("POST /firm/questionnaire and /firm/questionnaire/dismiss", () => {
  it("GET /firm/licenses reports questionnaire_pending:true for a brand-new firm", async () => {
    const { cookie } = await createFirmWithSession("Questionnaire Firm", `questionnaire-${Date.now()}@example.com`);
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { questionnaire_pending: boolean };
    expect(body.questionnaire_pending).toBe(true);
  });

  it("submitting the questionnaire stores the response and flips questionnaire_pending to false", async () => {
    const { cookie, firmId } = await createFirmWithSession("Questionnaire Submit Firm", `questionnairesub-${Date.now()}@example.com`);
    const submitResp = await SELF.fetch(`${BASE}/firm/questionnaire`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ selected_features: ["SMS reminders", "API access"], other_text: "Also: dark mode" }),
    });
    expect(submitResp.status).toBe(200);

    const row = await env.DB.prepare("SELECT selected_features, other_text FROM feature_questionnaire_responses WHERE firm_id = ?1")
      .bind(firmId)
      .first<{ selected_features: string; other_text: string | null }>();
    expect(JSON.parse(row!.selected_features)).toEqual(["SMS reminders", "API access"]);
    expect(row!.other_text).toBe("Also: dark mode");

    const licensesResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const licensesBody = (await licensesResp.json()) as { questionnaire_pending: boolean };
    expect(licensesBody.questionnaire_pending).toBe(false);
  });

  it("skipping (dismiss) flips questionnaire_pending to false without a response row", async () => {
    const { cookie, firmId } = await createFirmWithSession("Questionnaire Skip Firm", `questionnaireskip-${Date.now()}@example.com`);
    const dismissResp = await SELF.fetch(`${BASE}/firm/questionnaire/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    expect(dismissResp.status).toBe(200);

    const row = await env.DB.prepare("SELECT 1 FROM feature_questionnaire_responses WHERE firm_id = ?1").bind(firmId).first();
    expect(row).toBeNull();

    const licensesResp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const licensesBody = (await licensesResp.json()) as { questionnaire_pending: boolean };
    expect(licensesBody.questionnaire_pending).toBe(false);
  });

  it("401s with no session for both routes", async () => {
    expect((await SELF.fetch(`${BASE}/firm/questionnaire`, { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/firm/questionnaire/dismiss`, { method: "POST" })).status).toBe(401);
  });
});

// Roadmap #28 (2026-08-06, roadmap_items table): guided onboarding
// checklist. Only the server-side dismiss half is testable here -- the
// four step checkmarks themselves are computed client-side (roster/CPE
// data already in memory, or a localStorage visit flag), not a separate
// endpoint.
describe("POST /firm/onboarding-checklist/dismiss", () => {
  it("401s with no session", async () => {
    expect((await SELF.fetch(`${BASE}/firm/onboarding-checklist/dismiss`, { method: "POST" })).status).toBe(401);
  });

  it("GET /firm/licenses reports onboarding_checklist_pending:true for a brand-new firm, false after dismiss", async () => {
    const { cookie } = await createFirmWithSession("Onboarding Checklist Firm", `onboardingchecklist-${Date.now()}@example.com`);
    const before = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const beforeBody = (await before.json()) as { onboarding_checklist_pending: boolean };
    expect(beforeBody.onboarding_checklist_pending).toBe(true);

    const dismissResp = await SELF.fetch(`${BASE}/firm/onboarding-checklist/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    expect(dismissResp.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const afterBody = (await after.json()) as { onboarding_checklist_pending: boolean };
    expect(afterBody.onboarding_checklist_pending).toBe(false);
  });

  it("is independent of the feature-request questionnaire's own pending flag", async () => {
    const { cookie } = await createFirmWithSession("Independent Pending Firm", `independentpending-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/onboarding-checklist/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { onboarding_checklist_pending: boolean; questionnaire_pending: boolean };
    expect(body.onboarding_checklist_pending).toBe(false);
    expect(body.questionnaire_pending).toBe(true);
  });
});

// Roadmap #30 (2026-08-07, roadmap_items table): in-app product tour. Only
// the server-side dismiss half is testable here -- the 4-step sequence and
// its tooltip positioning are client-side only, same reasoning as #28's own
// test comment just above.
describe("POST /firm/product-tour/dismiss", () => {
  it("401s with no session", async () => {
    expect((await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, { method: "POST" })).status).toBe(401);
  });

  it("GET /firm/licenses reports product_tour_pending:true for a brand-new firm, false after dismiss", async () => {
    const { cookie } = await createFirmWithSession("Product Tour Firm", `producttour-${Date.now()}@example.com`);
    const before = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const beforeBody = (await before.json()) as { product_tour_pending: boolean };
    expect(beforeBody.product_tour_pending).toBe(true);

    const dismissResp = await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    expect(dismissResp.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const afterBody = (await after.json()) as { product_tour_pending: boolean };
    expect(afterBody.product_tour_pending).toBe(false);
  });

  it("is independent of the onboarding checklist's own pending flag", async () => {
    const { cookie } = await createFirmWithSession("Independent Tour Pending Firm", `independenttourpending-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    const resp = await SELF.fetch(`${BASE}/firm/licenses`, { headers: { Cookie: cookie } });
    const body = (await resp.json()) as { product_tour_pending: boolean; onboarding_checklist_pending: boolean };
    expect(body.product_tour_pending).toBe(false);
    expect(body.onboarding_checklist_pending).toBe(true);
  });

  it("is idempotent -- a second dismiss doesn't move the timestamp", async () => {
    const { cookie, firmId } = await createFirmWithSession("Idempotent Tour Dismiss Firm", `idempotenttour-${Date.now()}@example.com`);
    await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    const firmAfterFirst = await store.getFirmById(env.DB, firmId);
    const firstTimestamp = firmAfterFirst?.product_tour_dismissed_at;
    expect(firstTimestamp).toBeTruthy();

    await SELF.fetch(`${BASE}/firm/product-tour/dismiss`, { method: "POST", headers: { Cookie: cookie } });
    const firmAfterSecond = await store.getFirmById(env.DB, firmId);
    expect(firmAfterSecond?.product_tour_dismissed_at).toBe(firstTimestamp);
  });
});

describe("store.setFeatureIdeaStatus", () => {
  it("updates status and rejects an invalid value", async () => {
    const ok = await store.setFeatureIdeaStatus(env.DB, "idea-white-label", "in_progress");
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT status FROM feature_ideas WHERE id = ?1").bind("idea-white-label").first<{ status: string }>();
    expect(row?.status).toBe("in_progress");

    // Revert so this test is order-independent of the roadmap-data test above.
    await store.setFeatureIdeaStatus(env.DB, "idea-white-label", "open");

    const bad = await store.setFeatureIdeaStatus(env.DB, "idea-white-label", "not-a-real-status" as never);
    expect(bad).toBe(false);
  });
});
