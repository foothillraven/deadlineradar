/**
 * Roadmap #55 (2026-08-09): SendGrid Event Webhook signature verification.
 *
 * SendGrid signs `timestamp + raw_body` with ECDSA (P-256/SHA-256) and
 * sends the DER-encoded signature (base64) in the
 * X-Twilio-Email-Event-Webhook-Signature header, alongside the raw
 * timestamp in X-Twilio-Email-Event-Webhook-Timestamp. The public key
 * (base64 SPKI/DER) comes from the SendGrid dashboard when "Signed Event
 * Webhook" is enabled (Settings -> Mail Settings -> Webhook Settings ->
 * Event Webhook -> Security features).
 *
 * The one real interop gotcha here: Web Crypto's ECDSA `verify()` expects
 * RAW r||s signature bytes (64 bytes for P-256 -- two 32-byte big-endian
 * integers concatenated), but SendGrid sends DER-encoded signatures (an
 * ASN.1 SEQUENCE of two INTEGERs, each possibly 33 bytes with a leading
 * 0x00 sign-padding byte). derSignatureToRaw() below does that conversion.
 */

const P256_COORDINATE_BYTES = 32;

/**
 * Parses a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs, r and s)
 * into the raw 64-byte r||s format Web Crypto's ECDSA verify() requires.
 * Returns null (never throws) on any malformed input -- a signature that
 * doesn't parse is treated exactly like one that doesn't verify, both
 * fail closed the same way.
 */
export function derSignatureToRaw(der: Uint8Array): Uint8Array | null {
  try {
    let offset = 0;
    if (der[offset++] !== 0x30) return null; // SEQUENCE tag
    const seqLen = der[offset++];
    if (seqLen === undefined || seqLen >= 0x80) return null; // long-form length never expected here
    if (offset + seqLen !== der.length) return null; // trailing/truncated bytes

    const readInteger = (): Uint8Array | null => {
      if (der[offset++] !== 0x02) return null; // INTEGER tag
      const len = der[offset++];
      if (len === undefined || len >= 0x80) return null;
      if (offset + len > der.length) return null;
      const bytes = der.slice(offset, offset + len);
      offset += len;
      return bytes;
    };

    const rRaw = readInteger();
    const sRaw = readInteger();
    if (!rRaw || !sRaw) return null;
    if (offset !== der.length) return null; // must consume exactly the sequence

    const toFixedWidth = (v: Uint8Array): Uint8Array | null => {
      // DER left-pads with a single 0x00 when the high bit would otherwise
      // be read as a sign bit -- strip that, then left-pad with zeros to
      // the fixed P-256 coordinate width. Anything longer than that after
      // stripping is malformed (a real P-256 value never needs more).
      let v2 = v;
      if (v2.length > 0 && v2[0] === 0x00) v2 = v2.slice(1);
      if (v2.length > P256_COORDINATE_BYTES) return null;
      const out = new Uint8Array(P256_COORDINATE_BYTES);
      out.set(v2, P256_COORDINATE_BYTES - v2.length);
      return out;
    };

    const r = toFixedWidth(rRaw);
    const s = toFixedWidth(sRaw);
    if (!r || !s) return null;

    const raw = new Uint8Array(P256_COORDINATE_BYTES * 2);
    raw.set(r, 0);
    raw.set(s, P256_COORDINATE_BYTES);
    return raw;
  } catch {
    return null;
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Verifies a SendGrid Event Webhook payload. `rawBody` must be the exact
 * bytes as received (not re-serialized JSON -- a round-trip through
 * JSON.parse/JSON.stringify can change whitespace/key order and silently
 * break the signature, same "raw bytes" caution SendGrid's own docs give).
 * Never throws; any malformed input fails closed (returns false).
 */
export async function verifySendGridEventSignature(
  publicKeyBase64: string,
  signatureB64: string | null,
  timestamp: string | null,
  rawBody: string
): Promise<boolean> {
  if (!signatureB64 || !timestamp) return false;
  try {
    const rawSignature = derSignatureToRaw(fromBase64(signatureB64));
    if (!rawSignature) return false;

    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(publicKeyBase64) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const signedData = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      rawSignature as BufferSource,
      signedData as BufferSource
    );
  } catch {
    return false;
  }
}
