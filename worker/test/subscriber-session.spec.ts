import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as store from "../src/store";

async function seed(email: string, stateSlug: string, over: Partial<{ firmId: string }> = {}) {
  const row = await store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields: {},
    firstName: null,
    skipConfirmation: true,
    ...(over.firmId ? { firmId: over.firmId } : {}),
  } as Parameters<typeof store.addPending>[1]);
  return row;
}

describe("subscriber sign-in: identity is the EMAIL, and it must not over-match", () => {
  it("issues a login token and redeems it once", async () => {
    const email = `sub-login-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const first = await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken);
    expect(first?.emailNormalized).toBe(email.toLowerCase());
    // single-use: a captured or re-clicked link must not work twice
    expect(await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken)).toBeNull();
  });

  it("rejects an unknown token, and cannot be distinguished from a used one", async () => {
    expect(await store.verifyAndConsumeSubscriberLoginToken(env.DB, "never-issued-token")).toBeNull();
  });

  it("normalises case and whitespace, so the same person signs in either way", async () => {
    const email = `sub-case-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `  ${email.toUpperCase()}  `);
    const r = await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken);
    expect(r?.emailNormalized).toBe(email.toLowerCase());
  });

  it("does NOT fold gmail dots or +tags -- those may be different people", async () => {
    // cooldownKey() folds these together for abuse throttling. Using it for
    // IDENTITY would let first.last@ sign in and read firstlast@'s licences.
    const a = `first.last-${Date.now()}@gmail.com`;
    const b = a.replace(".", "");
    const ta = await store.createSubscriberLoginToken(env.DB, a);
    const ra = await store.verifyAndConsumeSubscriberLoginToken(env.DB, ta.rawToken);
    expect(ra?.emailNormalized).toBe(a.toLowerCase());
    expect(ra?.emailNormalized).not.toBe(b.toLowerCase());

    const plus = `tagged-${Date.now()}+work@gmail.com`;
    const tp = await store.createSubscriberLoginToken(env.DB, plus);
    const rp = await store.verifyAndConsumeSubscriberLoginToken(env.DB, tp.rawToken);
    expect(rp?.emailNormalized).toContain("+work");
  });
});

describe("subscriber sessions", () => {
  it("creates and verifies a session, and logout kills it", async () => {
    const email = `sub-sess-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email);
    expect((await store.verifySubscriberSession(env.DB, rawSessionToken))?.emailNormalized).toBe(email);
    await store.deleteSubscriberSession(env.DB, rawSessionToken);
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).toBeNull();
  });

  it("rejects a forged session token", async () => {
    expect(await store.verifySubscriberSession(env.DB, "forged-not-a-real-token")).toBeNull();
  });

  it("stores only a HASH -- the raw token is not in the table", async () => {
    const email = `sub-hash-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email);
    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM subscriber_sessions WHERE session_token_hash = ?1")
      .bind(rawSessionToken)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).not.toBeNull();
  });

  it("a SUBSCRIBER session token is not usable as a FIRM session -- separate tables, separate principals", async () => {
    // The whole reason these are different tables: an individual must never
    // be resolvable to a firm principal.
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, `sub-x-${Date.now()}@examplefirm.com`);
    expect(await store.verifySession(env.DB, rawSessionToken)).toBeNull();
  });

  it("a FIRM session token is not usable as a SUBSCRIBER session either", async () => {
    const { id } = await store.createFirm(env.DB, {
      name: "Cross Principal Firm",
      adminEmail: `crossp-${Date.now()}@examplefirm.com`,
    });
    const { rawSessionToken } = await store.createSession(env.DB, id);
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).toBeNull();
  });
});

describe("listSubscriberLicenses -- scoping is the whole security property", () => {
  it("returns every state for that email, and nothing belonging to anyone else", async () => {
    const mine = `roster-mine-${Date.now()}@examplefirm.com`;
    const theirs = `roster-theirs-${Date.now()}@examplefirm.com`;
    await seed(mine, "texas");
    await seed(mine, "california");
    await seed(theirs, "florida");

    const rows = await store.listSubscriberLicenses(env.DB, mine);
    expect(rows.map((r) => r.state_slug).sort()).toEqual(["california", "texas"]);
    expect(rows.every((r) => r.email.toLowerCase() === mine)).toBe(true);
  });

  it("matches case-insensitively but does NOT match a different address", async () => {
    const email = `roster-case-${Date.now()}@examplefirm.com`;
    await seed(email, "ohio");
    expect((await store.listSubscriberLicenses(env.DB, email)).length).toBe(1);
    // a near-miss address must return nothing
    expect((await store.listSubscriberLicenses(env.DB, "x" + email)).length).toBe(0);
  });

  it("returns an empty list for an unknown email rather than throwing", async () => {
    expect(await store.listSubscriberLicenses(env.DB, `nobody-${Date.now()}@examplefirm.com`)).toEqual([]);
  });

  it("EXCLUDES rows an admin removed, matching the firm roster's own rule", async () => {
    const email = `roster-removed-${Date.now()}@examplefirm.com`;
    const row = await seed(email, "georgia");
    await env.DB
      .prepare("UPDATE subscribers SET status = ?1, stop_reason = ?2 WHERE id = ?3")
      .bind("stopped", "removed_by_admin", row.id)
      .run();
    expect((await store.listSubscriberLicenses(env.DB, email)).length).toBe(0);
  });
});
