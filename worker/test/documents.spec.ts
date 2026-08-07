/**
 * Document storage (2026-08-07, roadmap #1/#2, migration 0032). D1 holds
 * only metadata; the R2 bucket (env.DOCUMENTS) holds the actual bytes. See
 * store.ts's own "Document storage" section for the full design.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

async function createFirmWithSession(name: string, adminEmail: string): Promise<{ firmId: string; cookie: string }> {
  const firm = await store.createFirm(env.DB, { name, adminEmail });
  const { rawSessionToken } = await store.createSession(env.DB, firm.id);
  return { firmId: firm.id, cookie: `dr_firm_session=${rawSessionToken}` };
}

async function addStaff(cookie: string, fields: Record<string, string>): Promise<{ id: string; email: string }> {
  const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify(fields),
  });
  expect(resp.status).toBe(201);
  return (await resp.json()) as { id: string; email: string };
}

function pdfBytes(size = 1024): Uint8Array {
  // "%PDF-" magic bytes + filler -- not a structurally valid PDF, but this
  // feature never parses file content, only the declared multipart
  // content-type, so realism beyond the magic bytes isn't needed.
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
  for (let i = 5; i < size; i++) bytes[i] = i % 256;
  return bytes;
}

function uploadForm(bytes: Uint8Array, kind: string, filename = "cert.pdf", contentType = "application/pdf"): FormData {
  const fd = new FormData();
  fd.append("file", new File([bytes], filename, { type: contentType }));
  fd.append("kind", kind);
  return fd;
}

async function uploadDocument(
  cookie: string,
  subscriberId: string,
  bytes: Uint8Array,
  kind = "license"
): Promise<Response> {
  return SELF.fetch(`${BASE}/firm/licenses/${subscriberId}/documents`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: uploadForm(bytes, kind),
  });
}

describe("POST /firm/licenses/:id/documents", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/licenses/whatever/documents`, {
      method: "POST",
      body: uploadForm(pdfBytes(), "license"),
    });
    expect(resp.status).toBe(401);
  });

  it("404s for a subscriber that doesn't belong to this firm", async () => {
    const { cookie } = await createFirmWithSession("Doc Firm A", `docfirma-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Doc Firm B", `docfirmb-${Date.now()}@example.com`);
    const staffB = await addStaff(cookieB, {
      staff_label: "B Staff",
      email: `bstaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const resp = await uploadDocument(cookie, staffB.id, pdfBytes());
    expect(resp.status).toBe(404);
  });

  it("uploads a valid PDF and returns 201 with the right metadata", async () => {
    const { cookie } = await createFirmWithSession("Upload Firm", `uploadfirm-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Upload Staff",
      email: `uploadstaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const resp = await uploadDocument(cookie, staff.id, pdfBytes(2048), "license");
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { document: { id: string; kind: string; filename: string; content_type: string; size_bytes: number } };
    expect(body.document.kind).toBe("license");
    expect(body.document.filename).toBe("cert.pdf");
    expect(body.document.content_type).toBe("application/pdf");
    expect(body.document.size_bytes).toBe(2048);
  });

  it("rejects a content type outside the allowlist", async () => {
    const { cookie } = await createFirmWithSession("Reject Type Firm", `rejecttype-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `rejecttypestaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const fd = new FormData();
    fd.append("file", new File([pdfBytes()], "notes.txt", { type: "text/plain" }));
    fd.append("kind", "license");
    const rejected = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}/documents`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: fd,
    });
    expect(rejected.status).toBe(400);
  });

  it("rejects a file over the 2MB cap", async () => {
    const { cookie } = await createFirmWithSession("Oversize Firm", `oversize-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `oversizestaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const resp = await uploadDocument(cookie, staff.id, pdfBytes(store.DOCUMENT_MAX_FILE_BYTES + 1));
    expect(resp.status).toBe(400);
  });

  it("rejects a missing or invalid kind", async () => {
    const { cookie } = await createFirmWithSession("Bad Kind Firm", `badkind-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `badkindstaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const fd = new FormData();
    fd.append("file", new File([pdfBytes()], "cert.pdf", { type: "application/pdf" }));
    fd.append("kind", "not-a-real-kind");
    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staff.id}/documents`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: fd,
    });
    expect(resp.status).toBe(400);
  });

  it("rejects an upload that would push the firm over its total storage cap", async () => {
    const { cookie, firmId } = await createFirmWithSession("Quota Firm", `quota-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `quotastaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    // Directly seed metadata near the cap rather than uploading real 2MB
    // files dozens of times over -- store.createDocument doesn't itself
    // enforce the quota (the HANDLER does, before calling it), so this is a
    // legitimate way to get a firm close to the ceiling quickly.
    await store.createDocument(env.DB, {
      firmId,
      subscriberId: staff.id,
      kind: "license",
      r2Key: `${firmId}/${staff.id}/seed`,
      filename: "seed.pdf",
      contentType: "application/pdf",
      sizeBytes: store.DOCUMENT_MAX_FIRM_TOTAL_BYTES - 100,
    });
    const resp = await uploadDocument(cookie, staff.id, pdfBytes(1000));
    expect(resp.status).toBe(400);
  });
});

describe("GET /firm/licenses/:id/documents", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/licenses/whatever/documents`);
    expect(resp.status).toBe(401);
  });

  it("lists only this subscriber's non-deleted documents, metadata only", async () => {
    const { cookie } = await createFirmWithSession("List Firm", `listfirm-${Date.now()}@example.com`);
    const staffA = await addStaff(cookie, {
      staff_label: "Staff A",
      email: `liststaffa-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const staffB = await addStaff(cookie, {
      staff_label: "Staff B",
      email: `liststaffb-${Date.now()}@example.com`,
      state_slug: "alabama",
      license_type_id: "al-all",
    });
    await uploadDocument(cookie, staffA.id, pdfBytes(500), "license");
    await uploadDocument(cookie, staffB.id, pdfBytes(500), "license");

    const resp = await SELF.fetch(`${BASE}/firm/licenses/${staffA.id}/documents`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { documents: { subscriber_id: string }[] };
    expect(body.documents.length).toBe(1);
    expect(body.documents[0]?.subscriber_id).toBe(staffA.id);
    // Metadata only -- no raw bytes field on the list response.
    expect(JSON.stringify(body.documents[0])).not.toContain("data");
  });
});

describe("GET /firm/documents/:id/download", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/documents/whatever/download`);
    expect(resp.status).toBe(401);
  });

  it("round-trips the exact bytes uploaded, with the right headers", async () => {
    const { cookie } = await createFirmWithSession("Download Firm", `downloadfirm-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `downloadstaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const bytes = pdfBytes(4096);
    const uploadResp = await uploadDocument(cookie, staff.id, bytes);
    const uploaded = (await uploadResp.json()) as { document: { id: string } };

    const downloadResp = await SELF.fetch(`${BASE}/firm/documents/${uploaded.document.id}/download`, {
      headers: { Cookie: cookie },
    });
    expect(downloadResp.status).toBe(200);
    expect(downloadResp.headers.get("Content-Type")).toBe("application/pdf");
    expect(downloadResp.headers.get("Content-Disposition")).toContain("attachment");
    expect(downloadResp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const downloaded = new Uint8Array(await downloadResp.arrayBuffer());
    expect(downloaded.length).toBe(bytes.length);
    expect(Array.from(downloaded)).toEqual(Array.from(bytes));
  });

  it("404s for a document belonging to a DIFFERENT firm", async () => {
    const { cookie: cookieA } = await createFirmWithSession("Isolation Firm A", `isoa-${Date.now()}@example.com`);
    const { cookie: cookieB } = await createFirmWithSession("Isolation Firm B", `isob-${Date.now()}@example.com`);
    const staffA = await addStaff(cookieA, {
      staff_label: "Staff A",
      email: `isostaffa-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const uploadResp = await uploadDocument(cookieA, staffA.id, pdfBytes());
    const uploaded = (await uploadResp.json()) as { document: { id: string } };

    const crossFirmResp = await SELF.fetch(`${BASE}/firm/documents/${uploaded.document.id}/download`, {
      headers: { Cookie: cookieB },
    });
    expect(crossFirmResp.status).toBe(404);
  });
});

describe("DELETE /firm/documents/:id", () => {
  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/documents/whatever`, { method: "DELETE" });
    expect(resp.status).toBe(401);
  });

  it("removes the D1 row and the R2 object -- a repeat download and a repeat delete both 404", async () => {
    const { cookie, firmId } = await createFirmWithSession("Delete Firm", `deletefirm-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `deletestaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const uploadResp = await uploadDocument(cookie, staff.id, pdfBytes());
    const uploaded = (await uploadResp.json()) as { document: { id: string } };

    const stored = await store.getDocumentForFirm(env.DB, firmId, uploaded.document.id);
    expect(stored).not.toBeNull();
    const r2Key = stored?.r2_key as string;
    expect(await env.DOCUMENTS.get(r2Key)).not.toBeNull();

    const deleteResp = await SELF.fetch(`${BASE}/firm/documents/${uploaded.document.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleteResp.status).toBe(200);

    expect(await env.DOCUMENTS.get(r2Key)).toBeNull();
    const afterDelete = await SELF.fetch(`${BASE}/firm/documents/${uploaded.document.id}/download`, { headers: { Cookie: cookie } });
    expect(afterDelete.status).toBe(404);

    const repeatDelete = await SELF.fetch(`${BASE}/firm/documents/${uploaded.document.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(repeatDelete.status).toBe(404);
  });
});

describe("POST /firm/cpe with document_id", () => {
  async function logCpeEntry(cookie: string, fields: Record<string, string>): Promise<Response> {
    return SELF.fetch(`${BASE}/firm/cpe`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify(fields),
    });
  }

  it("links a valid certificate belonging to the same subscriber", async () => {
    const { cookie } = await createFirmWithSession("CPE Doc Firm", `cpedoc-${Date.now()}@example.com`);
    const staff = await addStaff(cookie, {
      staff_label: "Staff",
      email: `cpedocstaff-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const uploadResp = await uploadDocument(cookie, staff.id, pdfBytes(), "cpe");
    const uploaded = (await uploadResp.json()) as { document: { id: string } };

    const resp = await logCpeEntry(cookie, {
      subscriber_id: staff.id,
      entry_date: "2026-01-15",
      hours: "2",
      category: "general",
      document_id: uploaded.document.id,
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { certificate_document_id: string | null };
    expect(body.certificate_document_id).toBe(uploaded.document.id);
  });

  it("rejects a document_id belonging to a DIFFERENT subscriber", async () => {
    const { cookie } = await createFirmWithSession("CPE Doc Mismatch Firm", `cpedocmismatch-${Date.now()}@example.com`);
    const staffA = await addStaff(cookie, {
      staff_label: "Staff A",
      email: `cpemismatcha-${Date.now()}@example.com`,
      state_slug: "georgia",
      license_type_id: "ga-individual",
    });
    const staffB = await addStaff(cookie, {
      staff_label: "Staff B",
      email: `cpemismatchb-${Date.now()}@example.com`,
      state_slug: "alabama",
      license_type_id: "al-all",
    });
    const uploadResp = await uploadDocument(cookie, staffA.id, pdfBytes(), "cpe");
    const uploaded = (await uploadResp.json()) as { document: { id: string } };

    const resp = await logCpeEntry(cookie, {
      subscriber_id: staffB.id,
      entry_date: "2026-01-15",
      hours: "2",
      category: "general",
      document_id: uploaded.document.id,
    });
    expect(resp.status).toBe(400);
  });
});
