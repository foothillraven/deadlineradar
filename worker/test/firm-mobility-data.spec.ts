import { describe, it, expect } from "vitest";
import rulesData from "../src/firm_mobility_rules.json";
import {
  normalizeFirmRuleRow,
  evaluateFirmMobility,
  isFirmRuleStale,
  type FirmMobilityRuleRow,
} from "../src/firm_mobility";

/**
 * Data-integrity tests for the firm-level registration ruleset (roadmap
 * #318, DiffLab's 2026-08-07/08 research pass). Same split as
 * mobility-data.spec.ts: these do NOT re-test the engine (that's
 * firm-mobility.spec.ts's job) -- they test the DATA, because the data is
 * sourced from outside this repo and a half-normalized row is worse than an
 * absent one.
 *
 * One real discrepancy caught and fixed on the way in, not left for a test
 * to discover later: DiffLab's own dataset keys the District of Columbia as
 * "district-of-columbia", but every other reference dataset in this repo
 * (cpa_deadlines.json, cpe_hours.json, etc.) uses "dc" -- confirmed via a
 * direct diff against cpa_deadlines.json's own 55-slug set, the ONLY
 * divergence found. worker/src/firm_mobility_rules.json remaps it to "dc"
 * (both the object key and the inner state_slug field) so
 * stateNameForSlug() -- which reads from that same canonical list --
 * actually resolves it; left as "district-of-columbia" it would 400 on
 * every real request for DC and the row would sit unreachable forever.
 */

const records = rulesData as Record<string, unknown>;
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

describe("firm mobility ruleset -- file shape", () => {
  it("carries all 55 canonical jurisdictions, zero missing, zero extra, using this repo's own slugs", () => {
    const slugs = Object.keys(records).sort();
    expect(slugs).toEqual([...CANONICAL_55].sort());
  });

  it("dc resolves and its inner state_slug field agrees with the object key", () => {
    const dc = records.dc as Record<string, unknown> | undefined;
    expect(dc).toBeDefined();
    expect(dc?.state_slug).toBe("dc");
    expect(dc?.state).toBe("District of Columbia");
  });

  it("no state's inner state_slug field disagrees with its own object key", () => {
    for (const [key, raw] of Object.entries(records)) {
      const slug = (raw as Record<string, unknown>).state_slug;
      expect(slug, `key "${key}" has inner state_slug "${slug}"`).toBe(key);
    }
  });
});

describe("every record survives normalizeFirmRuleRow() with nothing silently dropped", () => {
  for (const [slug, raw] of Object.entries(records)) {
    it(`${slug}: normalizes to a row rather than null`, () => {
      expect(normalizeFirmRuleRow(raw)).not.toBeNull();
    });

    it(`${slug}: no condition's exists field silently degrades a real true/false to null`, () => {
      const row = normalizeFirmRuleRow(raw) as FirmMobilityRuleRow;
      const src = raw as Record<string, Record<string, unknown>>;
      for (const field of ["attest_exemption", "physical_office_trigger", "peer_review_conditions_permit"] as const) {
        const key = field === "attest_exemption" ? "attestExemption" : field === "physical_office_trigger" ? "physicalOfficeTrigger" : "peerReviewConditionsPermit";
        const srcExists = src[field]?.exists;
        if (srcExists === null || srcExists === undefined) continue; // an honest null/omitted key is fine
        expect(row[key].exists, `${slug}.${field}.exists was ${JSON.stringify(srcExists)} but normalized differently`).toBe(srcExists);
      }
    });

    it(`${slug}: any citation present on a condition is substantive and survives`, () => {
      const row = normalizeFirmRuleRow(raw) as FirmMobilityRuleRow;
      const src = raw as Record<string, Record<string, unknown>>;
      for (const [field, key] of [
        ["attest_exemption", "attestExemption"],
        ["physical_office_trigger", "physicalOfficeTrigger"],
        ["peer_review_conditions_permit", "peerReviewConditionsPermit"],
      ] as const) {
        const srcCitation = src[field]?.citation;
        if (typeof srcCitation === "string" && srcCitation.trim().length >= 8) {
          expect(row[key].citation, `${slug}.${field}.citation was dropped`).not.toBeNull();
        }
      }
    });

    it(`${slug}: confidence is a recognised value, not silently nulled`, () => {
      const row = normalizeFirmRuleRow(raw) as FirmMobilityRuleRow;
      expect(["dual_source", "single_source", "unverified"]).toContain(row.confidence);
    });

    it(`${slug}: verified_date parses and is not in the future`, () => {
      const row = normalizeFirmRuleRow(raw) as FirmMobilityRuleRow;
      expect(row.verifiedDate).not.toBeNull();
      const t = Date.parse(row.verifiedDate as string);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeLessThanOrEqual(Date.now() + 86_400_000);
    });
  }
});

describe("locked-in dataset facts -- a change here should only come from a real re-sourcing pass", () => {
  const rows = Object.values(records)
    .map((r) => normalizeFirmRuleRow(r))
    .filter((r): r is FirmMobilityRuleRow => r !== null);

  it("exactly 4 states have a genuinely unclear (null) attest_exemption -- Maine, Massachusetts, Ohio, Tennessee", () => {
    const unclear = rows.filter((r) => r.attestExemption.exists === null).map((r) => r.stateSlug).sort();
    expect(unclear).toEqual(["maine", "massachusetts", "ohio", "tennessee"]);
  });

  it("exactly 4 states have an unverified physical_office_trigger -- Guam, US Virgin Islands, Utah, Wisconsin", () => {
    const unclear = rows.filter((r) => r.physicalOfficeTrigger.exists === null).map((r) => r.stateSlug).sort();
    expect(unclear).toEqual(["guam", "us-virgin-islands", "utah", "wisconsin"]);
  });

  it("exactly these states carry a real source_disagreement note (2026-08-17: WV, AZ resolved via direct primary-source text)", () => {
    const disagreeing = rows.filter((r) => r.sourceDisagreement !== null).map((r) => r.stateSlug).sort();
    expect(disagreeing).toEqual(
      ["nebraska", "new-hampshire", "new-jersey", "new-mexico", "new-york", "ohio", "pennsylvania", "us-virgin-islands", "vermont"].sort()
    );
  });
});

describe("the engine's answers are conservative where they should be, across the real dataset", () => {
  const rows = Object.values(records)
    .map((r) => normalizeFirmRuleRow(r))
    .filter((r): r is FirmMobilityRuleRow => r !== null);

  it("no state answers 'clear' while its attest_exemption is unknown (no physical office case)", () => {
    for (const row of rows) {
      if (row.attestExemption.exists === null) {
        const finding = evaluateFirmMobility(
          { firmHomeStateSlug: "ohio", targetStateSlug: row.stateSlug, hasPhysicalOfficeInTargetState: false },
          row,
          null
        );
        expect(finding.verdict, `${row.stateSlug} claimed ${finding.verdict} on an unknown attest exemption`).not.toBe("clear");
      }
    }
  });

  it("no state answers 'clear' while its physical_office_trigger is unknown (has-office case)", () => {
    for (const row of rows) {
      if (row.physicalOfficeTrigger.exists === null) {
        const finding = evaluateFirmMobility(
          { firmHomeStateSlug: "ohio", targetStateSlug: row.stateSlug, hasPhysicalOfficeInTargetState: true },
          row,
          null
        );
        expect(finding.verdict, `${row.stateSlug} claimed ${finding.verdict} on an unknown office trigger`).not.toBe("clear");
      }
    }
  });

  it("every state with a source_disagreement is not_verified, regardless of its other fields", () => {
    for (const row of rows) {
      if (row.sourceDisagreement !== null) {
        // A fixed home state that is never the target itself -- otherwise
        // the home==target not_applicable branch would short-circuit
        // before the source-disagreement check ever runs, for whichever
        // row happens to share a slug with the chosen home state.
        const home = row.stateSlug === "ohio" ? "california" : "ohio";
        const finding = evaluateFirmMobility(
          { firmHomeStateSlug: home, targetStateSlug: row.stateSlug, hasPhysicalOfficeInTargetState: false },
          row,
          null
        );
        expect(finding.verdict, `${row.stateSlug} claimed ${finding.verdict} despite a source disagreement`).toBe("not_verified");
      }
    }
  });

  it("a state with no record at all is not_verified, never a guess", () => {
    const finding = evaluateFirmMobility(
      { firmHomeStateSlug: "ohio", targetStateSlug: "atlantis", hasPhysicalOfficeInTargetState: false },
      null,
      null
    );
    expect(finding.verdict).toBe("not_verified");
  });

  it("every row is inside its verification TTL today", () => {
    for (const row of rows) {
      expect(isFirmRuleStale(row), `${row.stateSlug} is already past the TTL`).toBe(false);
    }
  });

  it("every conditionally-exempt state (peer_review_conditions_permit=true) actually surfaces the requirement text", () => {
    // The exact case the design pivot in the plan exists to protect: a
    // peer-review condition must never be silently absorbed into a bare
    // "clear" with no visible requirement.
    for (const row of rows) {
      if (row.attestExemption.exists === true && row.peerReviewConditionsPermit.exists === true) {
        const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
        const finding = evaluateFirmMobility(
          { firmHomeStateSlug: "ohio", targetStateSlug: row.stateSlug, hasPhysicalOfficeInTargetState: false },
          row,
          future
        );
        expect(finding.requirements.length, `${row.stateSlug} has a peer-review condition but no visible requirement`).toBeGreaterThan(0);
      }
    }
  });
});
