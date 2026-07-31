/**
 * CPA practice-privilege ("mobility") determinations (2026-07-30).
 *
 * ## Read this before changing anything in this file
 *
 * A wrong answer here means a CPA practices in a state without authority to
 * do so. That is a real legal exposure for them and for us. Every design
 * decision below exists to make a confidently-wrong answer STRUCTURALLY
 * IMPOSSIBLE rather than merely unlikely:
 *
 *   1. There is no boolean "allowed" in the output. The verdict is a
 *      three-state enum, and the third state -- NOT_VERIFIED -- is the
 *      DEFAULT that every unknown falls into. You cannot get a permissive
 *      answer by forgetting a case; forgetting a case yields
 *      "confirm with the board".
 *   2. A permissive verdict REQUIRES a citation. `evaluateMobility()`
 *      downgrades any would-be CLEAR result that lacks one -- see
 *      requireCitationOrDowngrade(). A rule row with no `citation` can
 *      never produce a green answer no matter what its booleans say.
 *   3. Missing data is never treated as permission. `null` means "we do not
 *      know", and every null path routes to NOT_VERIFIED, never to CLEAR.
 *      This is the opposite of the usual "default to the happy path"
 *      instinct and it is deliberate.
 *
 * ## What this is NOT
 *
 * This is informational, rule-cited, and explicitly not legal advice. The
 * product surface must say so, must show the citation next to every
 * determination, and must always tell the user to confirm with the state
 * board. See the directive: "NEVER assert 'you're cleared' without a
 * verified, cited rule."
 *
 * ## Staged data is expected, not a defect
 *
 * The rules dataset ships in batches. A state absent from the dataset
 * returns NOT_VERIFIED with an explanatory note -- that is the designed
 * behavior, not a gap to paper over. Do NOT add a state to the dataset
 * without a primary-source citation just to make the map look complete.
 */

export type MobilityVerdict =
  /** A verified, cited rule says the practitioner may proceed on this
   * basis. Requires a citation -- enforced, not assumed. */
  | "clear"
  /** A verified, cited rule says something is required first (firm
   * registration, notice, a fee, peer review). */
  | "action_required"
  /** We do not have verified data for this combination. The ONLY safe
   * default, and where every unknown lands. */
  | "not_verified";

export type ServiceType = "attest" | "tax" | "other_non_attest";

const SERVICE_TYPES = new Set<ServiceType>(["attest", "tax", "other_non_attest"]);

export function isValidServiceType(v: string): v is ServiceType {
  return SERVICE_TYPES.has(v as ServiceType);
}

/** One state's verified rules. Every field is nullable BY DESIGN: null
 * means "not verified", and null must never be read as permission. */
export interface MobilityRuleRow {
  state: string;
  state_slug: string;
  individual_practice_privilege: boolean | null;
  notice_required: boolean | null;
  fee_required: boolean | null;
  firm_registration_attest: boolean | null;
  firm_registration_tax: boolean | null;
  peer_review_required: boolean | null;
  citation: string | null;
  citation_url: string | null;
  source_url: string | null;
  verified_date: string | null;
  confidence: "dual_source" | "single_source" | "unverified" | null;
  data_gap_note: string | null;
  notes: string | null;

  /**
   * WHICH TEST this state uses to decide substantial equivalence. Added
   * 2026-07-30 after primary-source research found this cannot be modelled
   * as one boolean, because the states are actively DIVERGING on what the
   * question even is:
   *   - `nasba_state_level` -- the state defers to NASBA's National
   *     Qualification Appraisal Service determination about your home
   *     STATE (Illinois adopted this, P.A. 104-0228 eff. 2026-01-01)
   *   - `individual_criteria` -- the state tests YOUR credentials directly,
   *     regardless of your home state's status (Texas moved to this, SB 522
   *     eff. 2025-09-01; New York follows 2026-11-21)
   *
   * A single "are you substantially equivalent?" self-attestation asks the
   * WRONG question for whichever kind the state doesn't use. The engine
   * therefore refuses to interpret that attestation until it knows which
   * test applies. null = unknown, which forces not_verified.
   */
  equivalence_test: "nasba_state_level" | "individual_criteria" | "other" | null;

  /**
   * True when this state's rule is mid-change or its primary sources
   * disagree -- e.g. Illinois, where the enrolled Public Act and the
   * compiled statute currently state DIFFERENT tests for the same section,
   * and the compiled text cites the very act that contradicts it.
   *
   * Forces not_verified regardless of every other field. This is precisely
   * the situation where a confident product answer is worse than no answer,
   * so the engine refuses to pick a side between conflicting primary
   * sources.
   */
  rule_in_flux: boolean | null;

  /** Explanation of the conflict/change, shown to the user when
   * rule_in_flux is set. */
  flux_note: string | null;

  /** A known future date on which this state's rule changes, so the product
   * can warn ahead of time instead of silently going stale on the morning
   * the new rule takes effect. */
  rule_changes_on: string | null;
}

/**
 * How long a verified row stays trustworthy.
 *
 * Research found FOUR of five priority states changed or will change their
 * mobility rules inside a 14-month window (2025-09-01 through 2026-11-21).
 * A dataset that treats verification as durable would be confidently wrong
 * within months, so rows EXPIRE -- and expiry downgrades to not_verified
 * rather than merely annotating, because a stale permission is the exact
 * failure this feature cannot have.
 */
export const MOBILITY_VERIFICATION_TTL_DAYS = 180;

export function isRuleStale(rule: MobilityRuleRow, now: Date = new Date()): boolean {
  if (!rule.verified_date) return true;
  const verified = Date.parse(rule.verified_date);
  if (Number.isNaN(verified)) return true;
  return now.getTime() - verified > MOBILITY_VERIFICATION_TTL_DAYS * 86_400_000;
}

export interface MobilityInput {
  homeStateSlug: string;
  targetStateSlug: string;
  serviceType: ServiceType;
  /** The practitioner's own attestation that they hold an active license in
   * good standing. We cannot verify this and must not imply that we do --
   * it is an input to the determination, never a fact we assert. */
  licenseInGoodStanding: boolean;
  /** Substantial equivalence (the UAA "3E" test: 150 hours, 1 year
   * experience, passed the Uniform CPA Exam). Self-attested for the same
   * reason. */
  substantiallyEquivalent: boolean;
}

export interface MobilityFinding {
  verdict: MobilityVerdict;
  /** Plain-language, and deliberately never phrased as permission unless
   * the verdict is "clear" AND a citation exists. */
  summary: string;
  /** Everything the practitioner must do before proceeding. */
  requirements: string[];
  citation: string | null;
  citationUrl: string | null;
  sourceUrl: string | null;
  verifiedDate: string | null;
  confidence: MobilityRuleRow["confidence"];
  dataGapNote: string | null;
  /** Always present. The UI must render it next to every determination. */
  disclaimer: string;
}

export const MOBILITY_DISCLAIMER =
  "Informational only, not legal advice. Practice-privilege rules change and depend on facts we " +
  "can't see. Confirm with the state board of accountancy before you rely on this.";

const NOT_VERIFIED_SUMMARY =
  "We haven't verified this state's rule against a primary source yet, so we're not going to guess. " +
  "Confirm directly with the state board before providing services there.";

/**
 * The guard that makes a wrong green answer structurally impossible: a
 * "clear" verdict without a citation is downgraded to "not_verified".
 *
 * This exists because the dangerous failure is not a missing state -- it is
 * a PRESENT state whose booleans got filled in without a source. Rather
 * than trusting data review to catch that, the engine refuses to emit a
 * permissive verdict it cannot show a citation for.
 */
function requireCitationOrDowngrade(finding: MobilityFinding): MobilityFinding {
  if (finding.verdict === "clear" && !finding.citation) {
    return {
      ...finding,
      verdict: "not_verified",
      summary: NOT_VERIFIED_SUMMARY,
      requirements: [
        "This state's rule is in our dataset but has no primary-source citation, so we won't treat it as verified.",
      ],
    };
  }
  return finding;
}

/**
 * Conditions that make a row untrustworthy AS A WHOLE, checked before any
 * of its fields are read. Returns a finding to short-circuit with, or null
 * to proceed. Both evaluators call it, so a state in flux or past its
 * verification TTL cannot produce an answer through either path.
 */
function blockingRuleCondition(rule: MobilityRuleRow, now: Date): MobilityFinding | null {
  if (rule.rule_in_flux === true) {
    return {
      verdict: "not_verified",
      summary:
        "This state's rule is mid-change, or its primary sources currently disagree with each other. " +
        "We are not going to pick a side. Confirm directly with the state board before relying on this.",
      requirements: [rule.flux_note ?? "The governing rule is in transition or disputed between sources."],
      citation: rule.citation,
      citationUrl: rule.citation_url,
      sourceUrl: rule.source_url,
      verifiedDate: rule.verified_date,
      confidence: rule.confidence,
      dataGapNote: rule.data_gap_note,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  if (isRuleStale(rule, now)) {
    return {
      verdict: "not_verified",
      summary:
        "Our verification of this state's rule is older than we are willing to rely on. Rules in this " +
        "area have been changing quickly, so treat it as unverified and confirm with the board.",
      requirements: [
        "Last verified " +
          (rule.verified_date ?? "never") +
          "; we re-verify at least every " +
          MOBILITY_VERIFICATION_TTL_DAYS +
          " days.",
      ],
      citation: rule.citation,
      citationUrl: rule.citation_url,
      sourceUrl: rule.source_url,
      verifiedDate: rule.verified_date,
      confidence: rule.confidence,
      dataGapNote: rule.data_gap_note,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  return null;
}

function notVerified(rule: MobilityRuleRow | null, reason: string): MobilityFinding {
  return {
    verdict: "not_verified",
    summary: NOT_VERIFIED_SUMMARY,
    requirements: [reason],
    citation: rule?.citation ?? null,
    citationUrl: rule?.citation_url ?? null,
    sourceUrl: rule?.source_url ?? null,
    verifiedDate: rule?.verified_date ?? null,
    confidence: rule?.confidence ?? null,
    dataGapNote: rule?.data_gap_note ?? null,
    disclaimer: MOBILITY_DISCLAIMER,
  };
}

/**
 * Individual practice privilege in the TARGET state.
 *
 * Note the ordering: the practitioner's own attestations are checked FIRST,
 * because a CPA who is not in good standing or not substantially equivalent
 * has no practice privilege regardless of what the target state's rule
 * says. Answering "the state allows mobility" to someone who doesn't
 * qualify for it would be exactly the kind of technically-true, practically
 * dangerous answer this engine is built to avoid.
 */
export function evaluateIndividualMobility(
  input: MobilityInput,
  rule: MobilityRuleRow | null,
  now: Date = new Date()
): MobilityFinding {
  if (input.homeStateSlug === input.targetStateSlug) {
    return {
      verdict: "not_verified",
      summary:
        "That's your home state, so practice privilege doesn't apply -- you're working under your own " +
        "license. Check your license status and renewal date instead.",
      requirements: [],
      citation: null,
      citationUrl: null,
      sourceUrl: null,
      verifiedDate: null,
      confidence: null,
      dataGapNote: null,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  if (!input.licenseInGoodStanding) {
    return {
      verdict: "action_required",
      summary:
        "Practice privilege depends on holding an active license in good standing in your home state. " +
        "You've indicated yours isn't, so resolve that first.",
      requirements: ["Restore your home-state license to active, good standing."],
      citation: rule?.citation ?? null,
      citationUrl: rule?.citation_url ?? null,
      sourceUrl: rule?.source_url ?? null,
      verifiedDate: rule?.verified_date ?? null,
      confidence: rule?.confidence ?? null,
      dataGapNote: rule?.data_gap_note ?? null,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  if (!input.substantiallyEquivalent) {
    return {
      verdict: "action_required",
      summary:
        "Practice privilege generally requires meeting substantial-equivalence (150 semester hours, " +
        "one year of experience, and the Uniform CPA Exam). You've indicated you don't, so this needs " +
        "checking with the target state's board.",
      requirements: [
        "Confirm your substantial-equivalence status with the target state's board of accountancy.",
      ],
      citation: rule?.citation ?? null,
      citationUrl: rule?.citation_url ?? null,
      sourceUrl: rule?.source_url ?? null,
      verifiedDate: rule?.verified_date ?? null,
      confidence: rule?.confidence ?? null,
      dataGapNote: rule?.data_gap_note ?? null,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  if (!rule) {
    return notVerified(null, "This state isn't in our verified rules dataset yet.");
  }
  const blocked = blockingRuleCondition(rule, now);
  if (blocked) return blocked;
  // The practitioner's substantial-equivalence attestation cannot be
  // interpreted without knowing WHICH test this state applies: a
  // state-level NASBA determination and an individual-criteria test are
  // different questions, and answering one as though it were the other is
  // exactly the silent wrongness this engine exists to prevent.
  if (rule.equivalence_test === null) {
    return notVerified(rule, "We haven't verified which substantial-equivalence test this state applies.");
  }
  if (rule.individual_practice_privilege === null) {
    return notVerified(rule, "We haven't verified this state's individual practice-privilege rule.");
  }
  if (rule.individual_practice_privilege === false) {
    return {
      verdict: "action_required",
      summary:
        "This state does not extend practice privilege on the usual terms. You'll likely need a " +
        "license or another form of authorization before providing services here.",
      requirements: ["Contact the state board about licensure or authorization before providing services."],
      citation: rule.citation,
      citationUrl: rule.citation_url,
      sourceUrl: rule.source_url,
      verifiedDate: rule.verified_date,
      confidence: rule.confidence,
      dataGapNote: rule.data_gap_note,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  // Privilege exists. Surface any conditions attached to it. A null
  // condition is reported as unverified rather than assumed absent --
  // "we didn't find a notice requirement" is not the same as "there is
  // none", and only the first is honest.
  const requirements: string[] = [];
  if (rule.notice_required === true) requirements.push("File notice with the state board before practicing.");
  if (rule.notice_required === null) requirements.push("Notice requirement not verified -- confirm with the board.");
  if (rule.fee_required === true) requirements.push("A fee is payable to the state board.");
  if (rule.fee_required === null) requirements.push("Fee requirement not verified -- confirm with the board.");

  const hasUnverifiedCondition = rule.notice_required === null || rule.fee_required === null;

  return requireCitationOrDowngrade({
    verdict: requirements.length === 0 ? "clear" : hasUnverifiedCondition ? "not_verified" : "action_required",
    summary:
      requirements.length === 0
        ? "This state extends practice privilege to substantially-equivalent CPAs in good standing, " +
          "with no notice or fee we've identified."
        : "This state extends practice privilege, but with conditions -- see below.",
    requirements,
    citation: rule.citation,
    citationUrl: rule.citation_url,
    sourceUrl: rule.source_url,
    verifiedDate: rule.verified_date,
    confidence: rule.confidence,
    dataGapNote: rule.data_gap_note,
    disclaimer: MOBILITY_DISCLAIMER,
  });
}

/**
 * FIRM registration in the target state.
 *
 * Kept separate from individual mobility because they genuinely are
 * separate: an individual may hold practice privilege while the FIRM still
 * must register -- and that gap is the most common real-world mobility
 * mistake. Attest work commonly triggers firm registration where tax work
 * does not, which is why serviceType drives this and not the individual
 * determination.
 */
export function evaluateFirmRegistration(
  input: MobilityInput,
  rule: MobilityRuleRow | null,
  now: Date = new Date()
): MobilityFinding {
  if (input.homeStateSlug === input.targetStateSlug) {
    return {
      verdict: "not_verified",
      summary: "That's your home state -- firm registration there is a licensing question, not a mobility one.",
      requirements: [],
      citation: null,
      citationUrl: null,
      sourceUrl: null,
      verifiedDate: null,
      confidence: null,
      dataGapNote: null,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  if (!rule) {
    return notVerified(null, "This state isn't in our verified rules dataset yet.");
  }
  const blockedFirm = blockingRuleCondition(rule, now);
  if (blockedFirm) return blockedFirm;

  // Explicit per-service mapping. `other_non_attest` deliberately has NO
  // fallback: an earlier version resolved it to the TAX rule, which is
  // inferring one service's requirement from another's -- the exact error
  // this dataset's research brief forbids. "Other non-attest" covers
  // consulting, advisory and compilation-adjacent work whose treatment
  // genuinely varies by state, so until the dataset carries its own field
  // it returns not_verified rather than borrowing tax's answer.
  const required: boolean | null =
    input.serviceType === "attest"
      ? rule.firm_registration_attest
      : input.serviceType === "tax"
        ? rule.firm_registration_tax
        : null;

  if (required === null) {
    return notVerified(
      rule,
      input.serviceType === "attest"
        ? "We haven't verified whether attest work requires firm registration here."
        : input.serviceType === "tax"
          ? "We haven't verified whether tax work requires firm registration here."
          : "We don't hold a separate verified rule for non-attest services other than tax, and we " +
            "won't infer one from the tax rule. Confirm with the board."
    );
  }

  if (required === false) {
    return requireCitationOrDowngrade({
      verdict: "clear",
      summary: "We haven't identified a firm-registration requirement in this state for this service type.",
      requirements: [],
      citation: rule.citation,
      citationUrl: rule.citation_url,
      sourceUrl: rule.source_url,
      verifiedDate: rule.verified_date,
      confidence: rule.confidence,
      dataGapNote: rule.data_gap_note,
      disclaimer: MOBILITY_DISCLAIMER,
    });
  }

  const requirements = ["Register the firm with this state's board of accountancy before providing services."];
  if (rule.peer_review_required === true) {
    requirements.push("Peer review / practice monitoring is required as a condition of registration.");
  } else if (rule.peer_review_required === null) {
    requirements.push("Peer-review requirement not verified -- confirm with the board.");
  }

  return {
    verdict: "action_required",
    summary: "This state requires the firm to register before providing this service.",
    requirements,
    citation: rule.citation,
    citationUrl: rule.citation_url,
    sourceUrl: rule.source_url,
    verifiedDate: rule.verified_date,
    confidence: rule.confidence,
    dataGapNote: rule.data_gap_note,
    disclaimer: MOBILITY_DISCLAIMER,
  };
}

export interface MobilityResult {
  individual: MobilityFinding;
  firm: MobilityFinding;
  /** The most conservative of the two, so a caller rendering one badge
   * cannot accidentally show the greener half. Ordering is deliberate:
   * action_required outranks not_verified, because "we know you must do X"
   * is more actionable than "we don't know" -- but neither is ever
   * displaced by "clear". */
  overall: MobilityVerdict;
}

export function evaluateMobility(
  input: MobilityInput,
  rule: MobilityRuleRow | null,
  now: Date = new Date()
): MobilityResult {
  const individual = evaluateIndividualMobility(input, rule, now);
  const firm = evaluateFirmRegistration(input, rule, now);
  const verdicts = [individual.verdict, firm.verdict];
  const overall: MobilityVerdict = verdicts.includes("action_required")
    ? "action_required"
    : verdicts.includes("not_verified")
      ? "not_verified"
      : "clear";
  return { individual, firm, overall };
}
