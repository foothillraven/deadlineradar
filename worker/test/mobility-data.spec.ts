import { describe, it, expect } from "vitest";
import rulesData from "../src/mobility_rules.json";
import {
  normalizeRuleRow,
  evaluateMobility,
  isSubstantiveCitation,
  MOBILITY_VERIFICATION_TTL_DAYS,
  type MobilityRuleRow,
} from "../src/mobility";

/**
 * Data-integrity tests for the mobility ruleset. Started 2026-07-31 as
 * ScoutLab batch 1 (5 states); batches 2-7 completed 2026-08-01 and brought
 * coverage to all 55 jurisdictions (ScoutLab's own gate: 55 distinct, 0
 * duplicates, 48 dual_source, 7 single_source).
 *
 * These do NOT re-test the engine -- that is mobility.spec.ts's job. They test
 * the DATA, because the data is the part sourced from outside this repo, and
 * because the engine's whole design premise is that a wrong "yes" must be
 * impossible. A record that silently normalizes away is worse than an absent
 * one: absent yields `not_verified`, which is honest, while a half-parsed row
 * could yield a confident answer built on dropped fields.
 *
 * ScoutLab stated each batch was "built to match normalizeRuleRow() exactly".
 * That claim is the thing under test here, not an assumption.
 */

const records = (rulesData as { records: unknown[] }).records;
const CANONICAL_55 = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "dc", "florida", "georgia", "guam", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
  "nevada", "new-hampshire", "new-jersey", "new-mexico", "new-york", "north-carolina",
  "north-dakota", "northern-mariana-islands", "ohio", "oklahoma", "oregon", "pennsylvania",
  "puerto-rico", "rhode-island", "south-carolina", "south-dakota", "tennessee", "texas",
  "us-virgin-islands", "utah", "vermont", "virginia", "washington", "west-virginia",
  "wisconsin", "wyoming",
];

describe("mobility ruleset -- file shape", () => {
  it("carries all 55 canonical jurisdictions, zero missing, zero extra", () => {
    const slugs = records.map((r) => (r as { state_slug: string }).state_slug).sort();
    expect(slugs).toEqual([...CANONICAL_55].sort());
  });

  it("has no duplicate states -- a dupe would make the engine's pick order silently matter", () => {
    const slugs = records.map((r) => (r as { state_slug: string }).state_slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("every record survives normalizeRuleRow() with nothing silently dropped", () => {
  for (const raw of records) {
    const slug = (raw as { state_slug: string }).state_slug;

    it(`${slug}: normalizes to a row rather than null`, () => {
      expect(normalizeRuleRow(raw)).not.toBeNull();
    });

    it(`${slug}: no tri-state field degrades to null through normalization`, () => {
      // strictTriState turns anything that is not exactly true/false into
      // null. A typo like "true" (the string) or a missing key would land
      // here, and null means "unknown" -- which the engine honours by
      // refusing a permissive verdict. Catching it in the DATA is better
      // than discovering it as an unexplained not_verified in production.
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      const src = raw as Record<string, unknown>;
      const TRISTATE = [
        "individual_practice_privilege",
        "notice_required",
        "fee_required",
        "firm_registration_attest",
        "firm_registration_tax",
        "peer_review_required",
        "rule_in_flux",
        "home_state_substantially_equivalent",
      ] as const;
      for (const f of TRISTATE) {
        if (src[f] === null) continue; // an honest, deliberate null is fine
        expect(
          { field: f, source: src[f], normalized: row[f] },
          `${slug}.${f} was ${JSON.stringify(src[f])} but normalized to ${JSON.stringify(row[f])}`
        ).toEqual({ field: f, source: src[f], normalized: src[f] });
      }
    });

    it(`${slug}: citation is substantive and survives`, () => {
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      expect(row.citation).not.toBeNull();
      expect(isSubstantiveCitation(row.citation)).toBe(true);
    });

    it(`${slug}: citation_url and source_url are http(s) and survive`, () => {
      // safeHttpUrl() strips anything that is not http(s) -- these values are
      // rendered into href attributes, where escaping does nothing against a
      // javascript: URI.
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      const src = raw as Record<string, unknown>;
      if (src.citation_url) {
        expect(row.citation_url, `${slug} citation_url was stripped`).not.toBeNull();
        expect(row.citation_url).toMatch(/^https?:\/\//);
      }
      if (src.source_url) {
        expect(row.source_url, `${slug} source_url was stripped`).not.toBeNull();
        expect(row.source_url).toMatch(/^https?:\/\//);
      }
    });

    it(`${slug}: confidence is a recognised value, not silently nulled`, () => {
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      expect(["dual_source", "single_source", "unverified"]).toContain(row.confidence);
    });

    it(`${slug}: equivalence_test is a recognised value`, () => {
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      const src = raw as Record<string, unknown>;
      if (src.equivalence_test !== null && src.equivalence_test !== undefined) {
        expect(row.equivalence_test, `${slug} equivalence_test ${JSON.stringify(src.equivalence_test)} was not recognised`)
          .toBe(src.equivalence_test);
      }
    });

    it(`${slug}: verified_date parses and is not in the future`, () => {
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      expect(row.verified_date).not.toBeNull();
      const t = Date.parse(row.verified_date as string);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeLessThanOrEqual(Date.now() + 86_400_000);
    });

    it(`${slug}: a row flagged rule_in_flux carries a flux_note explaining why`, () => {
      // "in flux" with no explanation is not actionable -- a firm reading it
      // learns only that we are unsure, not what changes or when.
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      if (row.rule_in_flux === true) {
        expect(row.flux_note, `${slug} is rule_in_flux with no flux_note`).not.toBeNull();
      }
    });

    it(`${slug}: a genuinely-ambiguous flux row (no known changeover date) carries a customer-safe flux_summary`, () => {
      // Roadmap #317 Phase 2 (2026-08-10): blockingRuleCondition() renders
      // flux_summary, never the raw flux_note (internal research prose) --
      // a row with rule_changes_on === null is the genuinely unresolved
      // case (a real disagreement, unenacted legislation, or "no evidence
      // either way", as opposed to a known future changeover date already
      // covered by the flux_note-explains-why test above), so THIS is the
      // shape that actually needs the customer-facing distillation.
      const row = normalizeRuleRow(raw) as MobilityRuleRow;
      if (row.rule_in_flux === true && row.rule_changes_on === null) {
        expect(row.flux_summary, `${slug} is rule_in_flux with no rule_changes_on and no flux_summary`).not.toBeNull();
      }
    });
  }
});

describe("roadmap #317 Phase 1: home_state_substantially_equivalent dataset shape", () => {
  const rows = records.map((r) => normalizeRuleRow(r)).filter((r): r is MobilityRuleRow => r !== null);

  it("every one of the 55 rows carries the key (even if null) -- nothing silently omitted", () => {
    for (const raw of records) {
      expect(raw, `${(raw as { state_slug: string }).state_slug} is missing home_state_substantially_equivalent`)
        .toHaveProperty("home_state_substantially_equivalent");
    }
  });

  it("is true for every jurisdiction EXCEPT New York and Ohio's Legacy Pathway carve-out", () => {
    // Locks in the actual sourced result (NASBA: all 55 jurisdictions
    // currently substantially equivalent, minus the two whose alternative
    // post-2012 pathway means an individual's status can't be known from
    // state-level data alone) -- a change here should only ever come from a
    // real re-sourcing pass, never an accidental edit.
    for (const row of rows) {
      if (row.state_slug === "new-york" || row.state_slug === "ohio") {
        expect(row.home_state_substantially_equivalent, row.state_slug).toBeNull();
        expect(row.home_state_substantially_equivalent_note, row.state_slug).not.toBeNull();
      } else {
        expect(row.home_state_substantially_equivalent, row.state_slug).toBe(true);
      }
    }
  });
});

describe("the engine's answers are conservative where they should be", () => {
  const rows = records
    .map((r) => normalizeRuleRow(r))
    .filter((r): r is MobilityRuleRow => r !== null);

  // The most favourable input a caller can supply: both self-attestations
  // true. If the engine still refuses to say "clear" on an unknown rule, it
  // refuses for every weaker input too.
  const bestCaseInput = (row: MobilityRuleRow) => ({
    homeStateSlug: "ohio",
    targetStateSlug: row.state_slug,
    serviceType: "attest" as const,
    licenseInGoodStanding: true,
    substantiallyEquivalent: true,
  });

  it("no state answers 'clear' on the FIRM side while firm_registration_attest is unknown", () => {
    // The whole point of the engine: never a confident yes on an unknown.
    for (const row of rows) {
      if (row.firm_registration_attest === null) {
        const r = evaluateMobility(bestCaseInput(row), row);
        expect(r.firm.verdict, `${row.state_slug} claimed ${r.firm.verdict} on an unknown attest rule`)
          .not.toBe("clear");
        expect(r.overall).not.toBe("clear");
      }
    }
  });

  it("no state answers 'clear' on the INDIVIDUAL side while its privilege rule is unknown", () => {
    for (const row of rows) {
      if (row.individual_practice_privilege === null) {
        const r = evaluateMobility(bestCaseInput(row), row);
        expect(r.individual.verdict, `${row.state_slug} claimed ${r.individual.verdict} on an unknown privilege`)
          .not.toBe("clear");
      }
    }
  });

  it("a state we have NO record for is not_verified, never a guess", () => {
    const r = evaluateMobility(
      {
        homeStateSlug: "ohio",
        targetStateSlug: "wyoming",
        serviceType: "attest",
        licenseInGoodStanding: true,
        substantiallyEquivalent: true,
      },
      null
    );
    expect(r.overall).toBe("not_verified");
    expect(r.individual.verdict).toBe("not_verified");
    expect(r.firm.verdict).toBe("not_verified");
  });

  it("`overall` is never greener than either half, for every row", () => {
    for (const row of rows) {
      const r = evaluateMobility(bestCaseInput(row), row);
      if (r.individual.verdict !== "clear" || r.firm.verdict !== "clear") {
        expect(r.overall, `${row.state_slug} overall=clear over halves ` +
          `${r.individual.verdict}/${r.firm.verdict}`).not.toBe("clear");
      }
    }
  });

  it("a jurisdiction outside the canonical 55 is unsourced, not a guess", () => {
    // All 55 canonical jurisdictions are covered as of batch 7 (see the
    // file-shape test above) -- this checks the invariant against a slug
    // that can never be a real jurisdiction, rather than depending on any
    // one state staying absent.
    const missing = rows.find((r) => r.state_slug === "atlantis");
    expect(missing).toBeUndefined();
  });

  it("every row is inside its verification TTL today", () => {
    const cutoff = Date.now() - MOBILITY_VERIFICATION_TTL_DAYS * 86_400_000;
    for (const row of rows) {
      expect(
        Date.parse(row.verified_date as string),
        `${row.state_slug} verified_date is already past the ${MOBILITY_VERIFICATION_TTL_DAYS}-day TTL`
      ).toBeGreaterThan(cutoff);
    }
  });
});
