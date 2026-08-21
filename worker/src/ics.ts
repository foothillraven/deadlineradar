/**
 * Static .ics export for a firm's roster (2026-08-06, Devin's request off
 * the new Calendar feature -- "can I get these into my own calendar app?").
 * Deliberately a one-time download, not a live webcal:// subscription feed:
 * PRO_TIER_SPEC.md (now in the private deadlineradar-strategy repo) already scoped that as a
 * bigger, deliberately-deferred
 * integration surface (calendar apps can't send a session cookie, so a live
 * feed needs its own unauthenticated-but-token-scoped endpoint). Hand-rolled,
 * zero runtime dependency -- matches this codebase's own convention
 * (stripe.ts's own hand-written fetch() calls).
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  /** YYYY-MM-DD, rendered as an all-day event. */
  dateIso: string;
}

/** RFC 5545 TEXT escaping: backslash, comma, semicolon, then any line break. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r\n|\n|\r/g, "\\n");
}

function icsDateStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function icsAllDayDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/** RFC 5545 all-day events are exclusive on DTEND -- a one-day event on the
 * 5th needs DTSTART 5 / DTEND 6, not DTEND 5 (which renders as zero-length
 * in most calendar apps). */
function addOneDayIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ICS-1 (AuditLab, 2026-08-20, self-directed -- real RFC violation
// reachable with ordinary data, most clients tolerate it but strict
// CalDAV/import tooling can reject the whole file, no ruling needed for a
// well-scoped correctness fix in this shape). RFC 5545 SS3.1: a content
// line MUST NOT exceed 75 octets excluding the terminating CRLF; longer
// lines are folded across physical lines joined by CRLF + a single leading
// SPACE, which unfolding removes. SUMMARY breaches this on an everyday
// staff email/name + state name -- any label over ~36 characters with
// California, for example.
const ICS_MAX_LINE_OCTETS = 75;

/** Splits on octet boundaries, never inside a multi-byte UTF-8 sequence --
 * a UTF-8 continuation byte always has its top two bits as 10 (0x80-0xBF),
 * so backing up to the last non-continuation byte before the limit is the
 * correct place to break a line. */
function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= ICS_MAX_LINE_OCTETS) return line;

  const decoder = new TextDecoder("utf-8");
  const pieces: string[] = [];
  let start = 0;
  // The first physical line gets the full 75 octets; every continuation
  // line loses 1 octet to its own leading fold-space, so it gets 74.
  let limit = ICS_MAX_LINE_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
    pieces.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = ICS_MAX_LINE_OCTETS - 1;
  }
  return pieces.map((p, i) => (i === 0 ? p : " " + p)).join("\r\n");
}

/** asOf is a passed-in clock, never `new Date()` directly -- matches this
 * codebase's own "server writes are on a passed clock" testability
 * convention (deadline.ts, stripe.ts webhook handling, etc). */
export function buildIcs(events: IcsEvent[], asOf: Date): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Deadline-Radar//Firm Calendar Export//EN", "CALSCALE:GREGORIAN"];
  const dtstamp = icsDateStamp(asOf);
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      // Stable per-subscriber id -- re-downloading and re-importing doesn't
      // create duplicate events in a calendar app that dedupes by UID.
      `UID:${event.uid}@deadline-radar.com`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${icsAllDayDate(event.dateIso)}`,
      `DTEND;VALUE=DATE:${icsAllDayDate(addOneDayIso(event.dateIso))}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 requires CRLF line endings. Folded at the very end (every
  // emitted line, not just SUMMARY) so a future line type added above
  // can't reintroduce ICS-1 by being pushed unfolded.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
