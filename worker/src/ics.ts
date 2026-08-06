/**
 * Static .ics export for a firm's roster (2026-08-06, Devin's request off
 * the new Calendar feature -- "can I get these into my own calendar app?").
 * Deliberately a one-time download, not a live webcal:// subscription feed:
 * PRO_TIER_SPEC.md already scoped that as a bigger, deliberately-deferred
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

/** asOf is a passed-in clock, never `new Date()` directly -- matches this
 * codebase's own "server writes are on a passed clock" testability
 * convention (deadline.ts, stripe.ts webhook handling, etc). */
export function buildIcs(events: IcsEvent[], asOf: Date): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DeadlineRadar//Firm Calendar Export//EN", "CALSCALE:GREGORIAN"];
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
  // RFC 5545 requires CRLF line endings.
  return lines.join("\r\n") + "\r\n";
}
