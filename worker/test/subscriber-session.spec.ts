import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as store from "../src/store";

async function seed(email: string, stateSlug: string) {
  return store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields: {},
    firstName: null,
    skipConfirmation: true,
  });
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
    // Every negative needs a POSITIVE CONTROL in the same test -- otherwise
    // this passes even if the function were a bare `return null`.
    const email = `sub-oracle-${Date.now()}@examplefirm.com`;
    const live = await store.createSubscriberLoginToken(env.DB, email);
    const used = await store.createSubscriberLoginToken(env.DB, email);
    expect(await store.verifyAndConsumeSubscriberLoginToken(env.DB, used.rawToken)).not.toBeNull();

    const usedResult = await store.verifyAndConsumeSubscriberLoginToken(env.DB, used.rawToken);
    const unknownResult = await store.verifyAndConsumeSubscriberLoginToken(env.DB, "never-issued-token");
    // used and unknown must be INDISTINGUISHABLE
    expect(usedResult).toEqual(unknownResult);
    expect(usedResult).toBeNull();
    // and the control still works, proving the nulls above mean something
    expect(await store.verifyAndConsumeSubscriberLoginToken(env.DB, live.rawToken)).not.toBeNull();
  });

  it("rejects an EXPIRED login token", async () => {
    const email = `sub-expired-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    await env.DB
      .prepare("UPDATE subscriber_login_tokens SET expires_at = ?1 WHERE email_normalized = ?2")
      .bind(new Date(Date.now() - 60_000).toISOString(), email.toLowerCase())
      .run();
    expect(await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken)).toBeNull();
  });

  it("two concurrent redemptions of one link yield exactly one session", async () => {
    const email = `sub-race-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const results = await Promise.all([
      store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken),
      store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken),
    ]);
    expect(results.filter((r) => r !== null).length).toBe(1);
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

  it("rejects a forged session token, while a real one still works", async () => {
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, `sub-forge-${Date.now()}@examplefirm.com`);
    expect(await store.verifySubscriberSession(env.DB, "forged-not-a-real-token")).toBeNull();
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).not.toBeNull();
  });

  it("rejects an EXPIRED session", async () => {
    const email = `sub-sessexp-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email);
    await env.DB
      .prepare("UPDATE subscriber_sessions SET expires_at = ?1 WHERE email_normalized = ?2")
      .bind(new Date(Date.now() - 60_000).toISOString(), email)
      .run();
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).toBeNull();
  });

  it("stores only a HASH -- the raw token is in NO column of the row", async () => {
    const email = `sub-hash-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email);
    // SELECT * so a raw token smuggled into some OTHER column is caught too,
    // which the original single-column check would have missed.
    const row = await env.DB
      .prepare("SELECT * FROM subscriber_sessions WHERE email_normalized = ?1")
      .bind(email)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    for (const [col, value] of Object.entries(row ?? {})) {
      expect(`${col}=${String(value)}`).not.toContain(rawSessionToken);
    }
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).not.toBeNull();
  });

  it("a SUBSCRIBER session token is not usable as a FIRM session -- separate tables, separate principals", async () => {
    // The whole reason these are different tables: an individual must never
    // be resolvable to a firm principal. Asserting only that the FIRM
    // verifier returns null would also pass if that verifier were simply
    // broken -- so assert the token DOES resolve in its own system first.
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, `sub-x-${Date.now()}@examplefirm.com`);
    expect(await store.verifySubscriberSession(env.DB, rawSessionToken)).not.toBeNull();
    expect(await store.verifySession(env.DB, rawSessionToken)).toBeNull();
  });

  it("a FIRM session token is not usable as a SUBSCRIBER session either", async () => {
    const { id } = await store.createFirm(env.DB, {
      name: "Cross Principal Firm",
      adminEmail: `crossp-${Date.now()}@examplefirm.com`,
    });
    const { rawSessionToken } = await store.createSession(env.DB, id);
    expect(await store.verifySession(env.DB, rawSessionToken)).not.toBeNull();
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

  it("matches a MIXED-CASE stored address from its normalised form", async () => {
    // This test previously claimed to check case-insensitivity while using a
    // lowercase address at every step, so it proved nothing. The row is now
    // genuinely stored mixed-case and queried lowercase.
    const stored = `Roster-Case-${Date.now()}@ExampleFirm.com`;
    await seed(stored, "ohio");
    expect((await store.listSubscriberLicenses(env.DB, stored.toLowerCase())).length).toBe(1);
    // a near-miss address must return nothing
    expect((await store.listSubscriberLicenses(env.DB, `x${stored.toLowerCase()}`)).length).toBe(0);
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

describe("deleteOtherSubscriberSessions", () => {
  it("revokes the other sessions for that email and keeps the current one", async () => {
    const email = `sub-revoke-${Date.now()}@examplefirm.com`;
    const older = await store.createSubscriberSession(env.DB, email);
    const newer = await store.createSubscriberSession(env.DB, email);

    await store.deleteOtherSubscriberSessions(env.DB, email, newer.sessionId);

    expect(await store.verifySubscriberSession(env.DB, older.rawSessionToken)).toBeNull();
    expect(await store.verifySubscriberSession(env.DB, newer.rawSessionToken)).not.toBeNull();
  });

  it("never touches another person's sessions", async () => {
    const mine = `sub-revoke-mine-${Date.now()}@examplefirm.com`;
    const theirs = `sub-revoke-theirs-${Date.now()}@examplefirm.com`;
    const other = await store.createSubscriberSession(env.DB, theirs);
    const current = await store.createSubscriberSession(env.DB, mine);

    await store.deleteOtherSubscriberSessions(env.DB, mine, current.sessionId);

    expect(await store.verifySubscriberSession(env.DB, other.rawSessionToken)).not.toBeNull();
  });
});
