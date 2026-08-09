import { describe, it, expect } from "vitest";
import {
  evaluateFirmMobility,
  normalizeFirmRuleRow,
  isFirmRuleStale,
  type FirmMobilityInput,
  type FirmMobilityRuleRow,
  type FirmMobilityCondition,
} from "../src/firm_mobility";

function condition(over: Partial<FirmMobilityCondition> = {}): FirmMobilityCondition {
  return {
    exists: true,
    citation: "Tex. Occ. Code s 901.462",
    citationUrl: "https://example.gov/statute",
    notes: null,
    ...over,
  };
}

/** A fully-verified rule where attest work by a no-office firm is
 * unconditionally exempt -- the ONLY shape that should ever produce a bare
 * "clear" verdict with no peer-review requirement attached. */
function verifiedRule(over: Partial<FirmMobilityRuleRow> = {}): FirmMobilityRuleRow {
  return {
    state: "Texas",
    stateSlug: "texas",
    attestExemption: condition({ exists: true }),
    physicalOfficeTrigger: condition({ exists: true, citation: "Tex. Occ. Code s 901.461" }),
    peerReviewConditionsPermit: condition({ exists: false, citation: null }),
    confidence: "dual_source",
    sourceDisagreement: null,
    verifiedDate: new Date().toISOString().slice(0, 10),
    ...over,
  };
}

function input(over: Partial<FirmMobilityInput> = {}): FirmMobilityInput {
  return {
    firmHomeStateSlug: "california",
    targetStateSlug: "texas",
    hasPhysicalOfficeInTargetState: false,
    ...over,
  };
}

describe("SAFETY: the engine must never assert a clearance it cannot cite", () => {
  it("downgrades a would-be CLEAR verdict to not_verified when the attest exemption has NO citation", () => {
    const uncited = verifiedRule({ attestExemption: condition({ exists: true, citation: null }) });
    const finding = evaluateFirmMobility(input(), uncited, null);
    expect(finding.verdict).toBe("not_verified");
    expect(finding.citation).toBeNull();
    expect(finding.confidence).toBeNull();
  });

  it("does NOT downgrade action_required or not_verified for a missing citation -- only clear requires one", () => {
    const notExempt = verifiedRule({ attestExemption: condition({ exists: false, citation: null }) });
    const finding = evaluateFirmMobility(input(), notExempt, null);
    expect(finding.verdict).toBe("action_required");
  });
});

describe("no physical office -- the no-office attest-work case this dataset targets", () => {
  it("clear, unconditional: attest_exemption true, no peer-review condition", () => {
    const rule = verifiedRule();
    const finding = evaluateFirmMobility(input(), rule, null);
    expect(finding.verdict).toBe("clear");
    expect(finding.requirements).toEqual([]);
  });

  it("action_required: attest_exemption false -- must register regardless of peer review", () => {
    const rule = verifiedRule({ attestExemption: condition({ exists: false }) });
    const finding = evaluateFirmMobility(input(), rule, null);
    expect(finding.verdict).toBe("action_required");
  });

  it("the 4 genuinely-unclear states surface as not_verified, never guessed", () => {
    const rule = verifiedRule({ attestExemption: condition({ exists: null, citation: null }) });
    const finding = evaluateFirmMobility(input(), rule, null);
    expect(finding.verdict).toBe("not_verified");
  });
});

describe("the peer-review-conditional exemption -- the case this feature exists to get right", () => {
  function conditionalRule(): FirmMobilityRuleRow {
    return verifiedRule({
      attestExemption: condition({ exists: true, citation: "State Code s 1" }),
      peerReviewConditionsPermit: condition({
        exists: true,
        citation: "State Code s 2",
        notes: "Exemption requires current peer review.",
      }),
    });
  }

  it("stays clear when the firm's own peer-review due date is set and in the future", () => {
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const finding = evaluateFirmMobility(input(), conditionalRule(), future);
    expect(finding.verdict).toBe("clear");
    expect(finding.requirements.length).toBeGreaterThan(0); // condition still visible, not hidden
    expect(finding.requirements.join(" ")).toContain("peer review");
  });

  it("downgrades to action_required when no peer-review due date is on file", () => {
    const finding = evaluateFirmMobility(input(), conditionalRule(), null);
    expect(finding.verdict).toBe("action_required");
    expect(finding.requirements.join(" ")).toMatch(/no peer-review due date on file/i);
  });

  it("downgrades to action_required when the on-file peer-review due date is in the PAST", () => {
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const finding = evaluateFirmMobility(input(), conditionalRule(), past);
    expect(finding.verdict).toBe("action_required");
    expect(finding.requirements.join(" ")).toContain(past);
  });

  it("the peer-review condition is never silently folded away -- always its own requirements[] entry", () => {
    // This is the exact case the plan's own "31 vs 18 states" mismatch
    // surfaced: a naive boolean-AND enum would hide this distinction.
    // Verify the requirement text survives even on the CLEAR path.
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const finding = evaluateFirmMobility(input(), conditionalRule(), future);
    expect(finding.requirements).toContain("Exemption requires current peer review.");
  });

  it("null peerReviewConditionsPermit.exists (unverified whether it's conditional) forces not_verified", () => {
    const rule = verifiedRule({
      attestExemption: condition({ exists: true }),
      peerReviewConditionsPermit: condition({ exists: null, citation: null }),
    });
    const finding = evaluateFirmMobility(input(), rule, null);
    expect(finding.verdict).toBe("not_verified");
  });
});

describe("physical office in the target state -- a separate, unconditional trigger", () => {
  it("action_required when physical_office_trigger is true, REGARDLESS of attest exemption", () => {
    const rule = verifiedRule({
      attestExemption: condition({ exists: true }), // would be clear/exempt for the no-office case
      physicalOfficeTrigger: condition({ exists: true }),
    });
    const finding = evaluateFirmMobility(input({ hasPhysicalOfficeInTargetState: true }), rule, null);
    expect(finding.verdict).toBe("action_required");
  });

  it("clear when physical_office_trigger is false and cited", () => {
    const rule = verifiedRule({ physicalOfficeTrigger: condition({ exists: false }) });
    const finding = evaluateFirmMobility(input({ hasPhysicalOfficeInTargetState: true }), rule, null);
    expect(finding.verdict).toBe("clear");
  });

  it("not_verified when physical_office_trigger is unverified", () => {
    const rule = verifiedRule({ physicalOfficeTrigger: condition({ exists: null, citation: null }) });
    const finding = evaluateFirmMobility(input({ hasPhysicalOfficeInTargetState: true }), rule, null);
    expect(finding.verdict).toBe("not_verified");
  });

  it("does NOT consult attestExemption at all when a physical office is present", () => {
    // attestExemption.exists is null (would force not_verified on the
    // no-office path) but physicalOfficeTrigger is a clean false -- the
    // physical-office branch must not be contaminated by an unrelated
    // condition it doesn't read.
    const rule = verifiedRule({
      attestExemption: condition({ exists: null, citation: null }),
      physicalOfficeTrigger: condition({ exists: false }),
    });
    const finding = evaluateFirmMobility(input({ hasPhysicalOfficeInTargetState: true }), rule, null);
    expect(finding.verdict).toBe("clear");
  });
});

describe("SAFETY: source disagreement and staleness block regardless of every other field", () => {
  it("a non-null sourceDisagreement forces not_verified even on an otherwise clean, cited, permissive rule", () => {
    const rule = verifiedRule({ sourceDisagreement: "Statute and board guidance conflict on this point." });
    const finding = evaluateFirmMobility(input(), rule, null);
    expect(finding.verdict).toBe("not_verified");
    expect(finding.requirements).toContain("Statute and board guidance conflict on this point.");
  });

  it("a rule verified more than the TTL window ago is not_verified regardless of its booleans", () => {
    const stale = verifiedRule({ verifiedDate: new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10) });
    expect(isFirmRuleStale(stale)).toBe(true);
    const finding = evaluateFirmMobility(input(), stale, null);
    expect(finding.verdict).toBe("not_verified");
  });

  it("a rule with no verified_date at all is treated as stale, not as freshly unknown-but-fine", () => {
    const noDate = verifiedRule({ verifiedDate: null });
    expect(isFirmRuleStale(noDate)).toBe(true);
  });
});

describe("home == target and missing rule", () => {
  it("home state equals target -> not_applicable, not a lookup on the rule at all", () => {
    const finding = evaluateFirmMobility(input({ firmHomeStateSlug: "texas", targetStateSlug: "texas" }), null, null);
    expect(finding.verdict).toBe("not_applicable");
  });

  it("no rule for the target state -> not_verified, never guessed", () => {
    const finding = evaluateFirmMobility(input(), null, null);
    expect(finding.verdict).toBe("not_verified");
  });
});

describe("REGRESSION: undefined-is-not-null defect (same class mobility.ts's own review caught)", () => {
  it("an OMITTED exists key on a condition must never pass through as permissive", () => {
    const row = normalizeFirmRuleRow({
      state: "Texas",
      state_slug: "texas",
      attest_exemption: {}, // exists key omitted entirely -> undefined, not null
      physical_office_trigger: { exists: true, citation: "cite", citation_url: "https://x.gov" },
      peer_review_conditions_permit: {},
      confidence: "dual_source",
      verified_date: new Date().toISOString().slice(0, 10),
    });
    expect(row?.attestExemption.exists).toBeNull(); // coerced to null, never true
    const finding = evaluateFirmMobility(input(), row, null);
    expect(finding.verdict).toBe("not_verified");
  });
});

describe("REGRESSION: placeholder citations must not satisfy the citation-required guard", () => {
  it("a 'TBD' citation on the attest exemption is treated as no citation at all", () => {
    const row = normalizeFirmRuleRow({
      state: "Texas",
      state_slug: "texas",
      attest_exemption: { exists: true, citation: "TBD", citation_url: null },
      physical_office_trigger: { exists: true, citation: "real cite", citation_url: "https://x.gov" },
      peer_review_conditions_permit: { exists: false },
      confidence: "dual_source",
      verified_date: new Date().toISOString().slice(0, 10),
    });
    expect(row?.attestExemption.citation).toBeNull();
    const finding = evaluateFirmMobility(input(), row, null);
    expect(finding.verdict).toBe("not_verified");
  });
});

describe("disclaimer is always present", () => {
  it("every verdict shape carries the disclaimer", () => {
    for (const finding of [
      evaluateFirmMobility(input({ firmHomeStateSlug: "texas", targetStateSlug: "texas" }), null, null),
      evaluateFirmMobility(input(), null, null),
      evaluateFirmMobility(input(), verifiedRule(), null),
      evaluateFirmMobility(input(), verifiedRule({ attestExemption: condition({ exists: false }) }), null),
    ]) {
      expect(finding.disclaimer).toContain("not legal advice");
    }
  });
});
