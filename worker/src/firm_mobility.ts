/**
 * FIRM-level (not individual) practice-privilege/registration determinations
 * (2026-08-09, roadmap #318).
 *
 * Companion to mobility.ts, which answers "can this INDIVIDUAL CPA practice
 * across state lines." This module answers a structurally different
 * question DeadlineRadar never covered before: "does the FIRM ITSELF need to
 * register in a state where it has no office but is doing attest work for a
 * client there." Same stakes, same discipline -- a wrong answer here is a
 * real compliance exposure for the firm and for us -- so this reuses
 * mobility.ts's own proven primitives (`strictTriState`, `isSubstantiveCitation`,
 * `safeHttpUrl`, `MOBILITY_DISCLAIMER`, `MOBILITY_VERIFICATION_TTL_DAYS`)
 * rather than re-deriving a second, subtly different copy of the same
 * safety logic.
 *
 * Scoped explicitly to ATTEST engagements -- the one service type DiffLab's
 * dataset (`firm_mobility_rules.json`) actually covers. Mirrors
 * `evaluateFirmRegistration()`'s own `other_non_attest` precedent in
 * mobility.ts: refuses to infer a non-attest requirement from the attest
 * rule rather than silently broadening scope beyond what's verified.
 *
 * Dataset shape note: unlike mobility.ts's flat per-row booleans, each
 * state here nests THREE independent conditions (`attest_exemption`,
 * `physical_office_trigger`, `peer_review_conditions_permit`), each with
 * its OWN `{exists, citation, citation_url, notes}`. An earlier design for
 * this feature tried collapsing that into a single 3-value enum
 * (exempt/conditionally_exempt/not_exempt) -- checking that against the
 * REAL data threw it out: a plain boolean-AND of `attest_exemption.exists`
 * and `peer_review_conditions_permit.exists` produces 31 states, not the
 * "18 broader-conditional" states DiffLab's own research names, meaning the
 * real category boundary depends on each state's `notes` text in ways a
 * blanket 2-field rule doesn't capture safely. This module keeps the three
 * conditions separate and cited individually instead.
 */

import {
  strictTriState,
  isSubstantiveCitation,
  safeHttpUrl,
  MOBILITY_DISCLAIMER,
  MOBILITY_VERIFICATION_TTL_DAYS,
} from "./mobility";

export type FirmMobilityVerdict = "clear" | "action_required" | "not_verified" | "not_applicable";

/** One yes/no/unknown question about a state, always carrying its own
 * citation -- unlike mobility.ts's one-citation-per-row shape, this
 * dataset sources each condition independently, so a permissive verdict on
 * ONE condition can never borrow a citation verified for a different one. */
export interface FirmMobilityCondition {
  exists: boolean | null;
  citation: string | null;
  citationUrl: string | null;
  notes: string | null;
}

export interface FirmMobilityRuleRow {
  state: string;
  stateSlug: string;
  /** Is attest work by a firm with NO office in this state exempt from
   * registration? null = genuinely unclear (4 states in the current
   * dataset) -- never guessed. */
  attestExemption: FirmMobilityCondition;
  /** Does having a physical office in this state trigger firm registration
   * regardless of service type? true for 37 of 55 jurisdictions, false for
   * 14, and genuinely unverified (null) for 4 (Utah, Guam, US Virgin
   * Islands, Wisconsin) as of this dataset's current pass. */
  physicalOfficeTrigger: FirmMobilityCondition;
  /** Is the attest exemption above CONDITIONED on peer-review compliance?
   * When true, a "clear" verdict is not unconditional -- see
   * evaluateFirmMobility()'s own handling below. */
  peerReviewConditionsPermit: FirmMobilityCondition;
  confidence: "dual_source" | "single_source" | "unverified" | null;
  /** Non-null means this state's primary sources genuinely disagree with
   * each other (11 states in the current dataset) -- same "we will not
   * pick a side" posture as mobility.ts's `rule_in_flux`, applied to this
   * dataset's own conflict signal. Forces not_verified regardless of every
   * other field on the row. */
  sourceDisagreement: string | null;
  verifiedDate: string | null;
}

function normalizeCondition(raw: unknown): FirmMobilityCondition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { exists: null, citation: null, citationUrl: null, notes: null };
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    exists: strictTriState(r.exists),
    // A non-substantive citation is normalized AWAY, so the downstream
    // guard sees null and downgrades -- same convention as
    // mobility.ts's normalizeRuleRow().
    citation: isSubstantiveCitation(str(r.citation)) ? (r.citation as string) : null,
    citationUrl: safeHttpUrl(str(r.citation_url)),
    notes: str(r.notes),
  };
}

/** Normalizes a raw JSON row into a trustworthy FirmMobilityRuleRow, or
 * returns null if too malformed to use. The sole entry point from
 * untrusted JSON -- no unchecked row ever reaches an evaluator. */
export function normalizeFirmRuleRow(raw: unknown): FirmMobilityRuleRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state_slug !== "string" || r.state_slug.length === 0) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const conf = r.confidence;
  return {
    state: typeof r.state === "string" ? r.state : r.state_slug,
    stateSlug: r.state_slug,
    attestExemption: normalizeCondition(r.attest_exemption),
    physicalOfficeTrigger: normalizeCondition(r.physical_office_trigger),
    peerReviewConditionsPermit: normalizeCondition(r.peer_review_conditions_permit),
    confidence: conf === "dual_source" || conf === "single_source" || conf === "unverified" ? conf : null,
    sourceDisagreement: str(r.source_disagreement),
    verifiedDate: str(r.verified_date),
  };
}

export function isFirmRuleStale(rule: FirmMobilityRuleRow, now: Date = new Date()): boolean {
  if (!rule.verifiedDate) return true;
  const verified = Date.parse(rule.verifiedDate);
  if (Number.isNaN(verified)) return true;
  return now.getTime() - verified > MOBILITY_VERIFICATION_TTL_DAYS * 86_400_000;
}

export interface FirmMobilityInput {
  firmHomeStateSlug: string;
  targetStateSlug: string;
  /** Self-attested at REQUEST time, never stored -- same convention
   * mobility.ts already established for home state / license-good-standing
   * / substantial-equivalence: this codebase decided a firm's "home state"
   * and office footprint aren't persisted fields, asking fresh each time
   * is the existing pattern, not a gap to fix here. */
  hasPhysicalOfficeInTargetState: boolean;
}

export interface FirmMobilityFinding {
  verdict: FirmMobilityVerdict;
  summary: string;
  requirements: string[];
  citation: string | null;
  citationUrl: string | null;
  verifiedDate: string | null;
  confidence: FirmMobilityRuleRow["confidence"];
  disclaimer: string;
}

const NOT_VERIFIED_SUMMARY =
  "We haven't verified this state's firm-registration rule against a primary source yet, so we're not " +
  "going to guess. Confirm directly with the state board before relying on this.";

function notVerified(rule: FirmMobilityRuleRow | null, reason: string): FirmMobilityFinding {
  return {
    verdict: "not_verified",
    summary: NOT_VERIFIED_SUMMARY,
    requirements: [reason],
    citation: null,
    citationUrl: null,
    verifiedDate: rule?.verifiedDate ?? null,
    confidence: rule?.confidence ?? null,
    disclaimer: MOBILITY_DISCLAIMER,
  };
}

/** Same guard as mobility.ts's requireCitationOrDowngrade(): a "clear"
 * verdict without a substantive citation is force-downgraded to
 * not_verified, provenance cleared rather than carried over. */
function requireCitationOrDowngrade(finding: FirmMobilityFinding): FirmMobilityFinding {
  if (finding.verdict === "clear" && !isSubstantiveCitation(finding.citation)) {
    return {
      ...finding,
      verdict: "not_verified",
      summary: NOT_VERIFIED_SUMMARY,
      requirements: [
        "This state's rule is in our dataset but has no usable primary-source citation, so we won't treat it as verified.",
      ],
      citation: null,
      citationUrl: null,
      verifiedDate: null,
      confidence: null,
    };
  }
  return finding;
}

/** Conditions that make a row untrustworthy AS A WHOLE, checked before any
 * condition-specific field is read -- mirrors mobility.ts's
 * blockingRuleCondition(). A state with disagreeing primary sources or a
 * stale verification cannot produce an answer through any path. */
function blockingFirmRuleCondition(rule: FirmMobilityRuleRow, now: Date): FirmMobilityFinding | null {
  if (rule.sourceDisagreement) {
    return {
      verdict: "not_verified",
      summary:
        "This state's primary sources currently disagree with each other on firm registration. We are not " +
        "going to pick a side. Confirm directly with the state board before relying on this.",
      requirements: [rule.sourceDisagreement],
      citation: null,
      citationUrl: null,
      verifiedDate: rule.verifiedDate,
      confidence: rule.confidence,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  if (isFirmRuleStale(rule, now)) {
    return {
      verdict: "not_verified",
      summary:
        "Our verification of this state's firm-registration rule is older than we are willing to rely on. " +
        "Confirm with the board.",
      requirements: [
        `Last verified ${rule.verifiedDate ?? "never"}; we re-verify at least every ${MOBILITY_VERIFICATION_TTL_DAYS} days.`,
      ],
      citation: null,
      citationUrl: null,
      verifiedDate: rule.verifiedDate,
      confidence: rule.confidence,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  return null;
}

/** Self-reported, not independently verified -- same posture this codebase
 * already uses verbatim for CPE hours. A due date must be SET and in the
 * FUTURE to count as current peer-review compliance. */
function isPeerReviewCurrent(dueDate: string | null, now: Date): boolean {
  if (!dueDate) return false;
  const parsed = Date.parse(dueDate);
  if (Number.isNaN(parsed)) return false;
  return parsed > now.getTime();
}

/**
 * FIRM-level attest-engagement registration requirement in the target
 * state. `firmPeerReviewDueDate` is read server-side from the firm's own
 * stored `peer_review_due_date` (never client-supplied) -- see index.ts's
 * handleFirmMobilityFirmCheck.
 *
 * Ordering: home==target short-circuits first (not a mobility question);
 * then the whole-row blocking conditions (source disagreement, staleness);
 * then physical-office-trigger, which is evaluated BEFORE the no-office
 * attest exemption because it's a separate, unconditional trigger -- a
 * firm with a physical office in the target state doesn't get to claim the
 * no-office exemption regardless of what attest_exemption says.
 */
export function evaluateFirmMobility(
  input: FirmMobilityInput,
  rule: FirmMobilityRuleRow | null,
  firmPeerReviewDueDate: string | null,
  now: Date = new Date()
): FirmMobilityFinding {
  if (input.firmHomeStateSlug === input.targetStateSlug) {
    return {
      verdict: "not_applicable",
      summary: "That's your firm's home state -- registration there is a licensing question, not a mobility one.",
      requirements: [],
      citation: null,
      citationUrl: null,
      verifiedDate: null,
      confidence: null,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }
  if (!rule) {
    return notVerified(null, "This state isn't in our verified firm-registration dataset yet.");
  }
  const blocked = blockingFirmRuleCondition(rule, now);
  if (blocked) return blocked;

  if (input.hasPhysicalOfficeInTargetState) {
    const trigger = rule.physicalOfficeTrigger;
    if (trigger.exists === null) {
      return notVerified(
        rule,
        "We haven't verified whether a physical office in this state triggers firm registration."
      );
    }
    if (trigger.exists === false) {
      return requireCitationOrDowngrade({
        verdict: "clear",
        summary:
          "We haven't identified a firm-registration requirement in this state for a firm with a physical office here.",
        requirements: [],
        citation: trigger.citation,
        citationUrl: trigger.citationUrl,
        verifiedDate: rule.verifiedDate,
        confidence: rule.confidence,
        disclaimer: MOBILITY_DISCLAIMER,
      });
    }
    return {
      verdict: "action_required",
      summary: "This state requires firm registration for a firm with a physical office here.",
      requirements: [
        trigger.notes ?? "Register the firm with this state's board of accountancy before providing services.",
      ],
      citation: trigger.citation,
      citationUrl: trigger.citationUrl,
      verifiedDate: rule.verifiedDate,
      confidence: rule.confidence,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  // No physical office -- the no-office attest-work case this dataset was
  // built to answer.
  const exemption = rule.attestExemption;
  if (exemption.exists === null) {
    return notVerified(
      rule,
      "We haven't verified whether attest work by a no-office firm is exempt from registration in this state."
    );
  }
  if (exemption.exists === false) {
    return {
      verdict: "action_required",
      summary: "This state requires firm registration for attest work, even without a physical office here.",
      requirements: [
        exemption.notes ?? "Register the firm with this state's board of accountancy before providing attest services.",
      ],
      citation: exemption.citation,
      citationUrl: exemption.citationUrl,
      verifiedDate: rule.verifiedDate,
      confidence: rule.confidence,
      disclaimer: MOBILITY_DISCLAIMER,
    };
  }

  // exemption.exists === true -- base case is clear, but the exemption may
  // be conditioned on peer-review compliance. Surfaced as an explicit,
  // separately-cited requirement rather than folded into a single enum
  // value, so the condition can never be silently hidden.
  const permit = rule.peerReviewConditionsPermit;
  const requirements: string[] = [];
  let verdict: FirmMobilityVerdict = "clear";
  let summary =
    "We haven't identified a firm-registration requirement in this state for attest work by a no-office firm.";

  if (permit.exists === true) {
    const compliant = isPeerReviewCurrent(firmPeerReviewDueDate, now);
    requirements.push(
      permit.notes ??
        "This exemption is conditioned on peer-review compliance -- confirm your firm's peer review is current."
    );
    if (!compliant) {
      verdict = "action_required";
      summary =
        "This state's exemption from firm registration requires current peer-review compliance, and your " +
        "firm doesn't have a current peer-review due date on file (self-reported, not independently verified).";
      requirements.push(
        firmPeerReviewDueDate
          ? `Your firm's on-file peer-review due date (${firmPeerReviewDueDate}) has passed -- update it once your review is current.`
          : "Your firm has no peer-review due date on file -- set one from the dashboard's Account tab once your review is current."
      );
    } else {
      summary =
        "This state exempts attest work by a no-office firm from registration, conditioned on peer-review " +
        "compliance -- your firm's on-file peer-review due date is current (self-reported, not independently verified).";
    }
  } else if (permit.exists === null) {
    requirements.push(
      "Whether this exemption is conditioned on peer-review compliance hasn't been verified -- confirm with the board."
    );
    verdict = "not_verified";
    summary = NOT_VERIFIED_SUMMARY;
  }

  return requireCitationOrDowngrade({
    verdict,
    summary,
    requirements,
    citation: exemption.citation,
    citationUrl: exemption.citationUrl,
    verifiedDate: rule.verifiedDate,
    confidence: rule.confidence,
    disclaimer: MOBILITY_DISCLAIMER,
  });
}
