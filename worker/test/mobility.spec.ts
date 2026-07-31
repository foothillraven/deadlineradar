import { describe, it, expect } from "vitest";
import {
  evaluateMobility,
  evaluateIndividualMobility,
  evaluateFirmRegistration,
  isValidServiceType,
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
    const res = evaluateIndividualMobility(input({ targetStateSlug: "california" }), verifiedPermissiveRule());
    expect(res.verdict).toBe("not_verified");
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
