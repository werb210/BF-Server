// BF_SERVER_SBA_SIGNING_v96
// One SignNow envelope per signer: each owner's personal financial forms stay private.
import { createHash, randomUUID } from "node:crypto";
import { dbQuery, pool } from "../../db.js";
import {
  isApiKeyConfigured,
  uploadDocumentWithFieldExtract,
  createDocumentGroup,
  createEmbeddedGroupInvite,
  createEmbeddedGroupLink,
  getDocumentGroupStatus,
  downloadDocument,
} from "../signnowClient.js";
import { getStorage } from "../../lib/storage/index.js";
import { resolveSbaOwners, loadSbaContext } from "./sbaOwners.js";
import { buildSba1919, buildSba912, buildSba413 } from "./sbaFormBuilder.js";
import { logInfo, logError } from "../../observability/logger.js";

const SBA_DOC_CATEGORY = "SBA Forms";

type Envelope = { ownerIndex: number; email: string; groupId: string; inviteId: string; docIds: string[] };

async function sbaEnvelopes(applicationId: string): Promise<Envelope[]> {
  const result = await dbQuery<{ metadata: any }>(
    `SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  ).catch(() => ({ rows: [] as Array<{ metadata: any }> }));
  const raw = result.rows[0]?.metadata?.sba_signnow;
  return Array.isArray(raw) ? (raw as Envelope[]) : [];
}

/** Build every SBA form and open one signing session per owner. */
export async function createSbaSigningSessions(applicationId: string): Promise<
  Array<{ ownerIndex: number; name: string; email: string; url: string | null }>
> {
  if (!isApiKeyConfigured()) return [];
  const owners = await resolveSbaOwners(applicationId);
  if (owners.length === 0) return [];
  const ctx = await loadSbaContext(applicationId);
  const envelopes: Envelope[] = [];
  const out: Array<{ ownerIndex: number; name: string; email: string; url: string | null }> = [];

  for (const owner of owners) {
    if (!owner.email) {
      logInfo("sba_signing_owner_skipped_no_email", { applicationId, ownerIndex: owner.index });
      out.push({ ownerIndex: owner.index, name: owner.fullName, email: "", url: null });
      continue;
    }

    const docs: Array<{ bytes: Uint8Array; filename: string }> = [];
    // Form 1919 is one per co-applicant and goes only to the authorized representative.
    if (owner.index === 1) {
      const bytes = await buildSba1919({
        applicationId,
        business: ctx.business,
        kyc: ctx.kyc,
        form1919: ctx.form1919,
        owners,
      });
      if (bytes) docs.push({ bytes, filename: `sba-1919-${applicationId}.pdf` });
    }
    const form912 = await buildSba912({ business: ctx.business, owner });
    if (form912) docs.push({ bytes: form912, filename: `sba-912-owner${owner.index}-${applicationId}.pdf` });
    const data413 = ctx.form413ByOwner.get(String(owner.index)) ?? {};
    const form413 = await buildSba413({ business: ctx.business, owner, data: data413 });
    if (form413) docs.push({ bytes: form413, filename: `sba-413-owner${owner.index}-${applicationId}.pdf` });

    if (docs.length === 0) {
      out.push({ ownerIndex: owner.index, name: owner.fullName, email: owner.email, url: null });
      continue;
    }

    try {
      const docIds: string[] = [];
      for (const doc of docs) {
        const { documentId } = await uploadDocumentWithFieldExtract(doc.bytes, doc.filename);
        docIds.push(documentId);
      }
      const { groupId } = await createDocumentGroup(docIds, `SBA Forms ${applicationId} owner ${owner.index}`);
      const { inviteId } = await createEmbeddedGroupInvite(groupId, docIds, [
        { email: owner.email, name: owner.fullName || undefined, roleName: `Owner ${owner.index}` },
      ]);
      const { url } = await createEmbeddedGroupLink(groupId, inviteId, owner.email);
      envelopes.push({ ownerIndex: owner.index, email: owner.email, groupId, inviteId, docIds });
      out.push({ ownerIndex: owner.index, name: owner.fullName, email: owner.email, url });
    } catch (error) {
      logError("sba_signing_session_failed");
      console.warn("[sba_signing]", applicationId, owner.index, error instanceof Error ? error.message : String(error));
      out.push({ ownerIndex: owner.index, name: owner.fullName, email: owner.email, url: null });
    }
  }

  await dbQuery(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('sba_signnow', $2::jsonb),
            updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId, JSON.stringify(envelopes)],
  ).catch(() => {});
  return out;
}

/** Fail closed while any SBA envelope is unsigned or its status cannot be read. */
export async function sbaSigningSatisfiedForDispatch(applicationId: string): Promise<boolean> {
  if (!isApiKeyConfigured()) return true;

  // BF_SERVER_SBA_V103
  // createSbaSigningSessions() skips any owner with no email address - it logs
  // sba_signing_owner_skipped_no_email and moves on. This gate then checked only
  // the envelopes that WERE created, so a skipped owner read as satisfied, and
  // "no envelopes at all" read as satisfied outright. Either way the package
  // shipped to the lender missing a signed Form 413 from a 20%+ owner, which SBA
  // requires, with nothing raised anywhere.
  //
  // The set of owners is the authority, not the set of envelopes. Every owner
  // resolved for this application must have an envelope AND that envelope must
  // be signed. An SBA application with no resolvable owners is not dispatchable
  // either - there is no such thing as a 7(a) file with no principals.
  let owners: Array<{ index: number }> = [];
  try {
    owners = await resolveSbaOwners(applicationId);
  } catch {
    // Cannot establish who must sign, so cannot assert that they did.
    return false;
  }
  if (owners.length === 0) return false;

  const envelopes = await sbaEnvelopes(applicationId);
  const byOwner = new Map(envelopes.map((e) => [e.ownerIndex, e]));

  for (const owner of owners) {
    const envelope = byOwner.get(owner.index);
    if (!envelope) {
      logInfo("sba_dispatch_blocked_missing_envelope", { applicationId, ownerIndex: owner.index });
      return false;
    }
    try {
      if ((await getDocumentGroupStatus(envelope.groupId)).signed !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Return every signed SBA PDF, or an empty array if any form is outstanding. */
export async function getSignedSbaPdfs(applicationId: string): Promise<Array<{ filename: string; content: Buffer }>> {
  if (!isApiKeyConfigured()) return [];
  const envelopes = await sbaEnvelopes(applicationId);
  // BF_SERVER_SBA_V103 - an empty envelope list is not
  // "nothing to attach", it is "signing never happened". The dispatch gate above
  // now refuses that case, so reaching here with none is a logic error worth a log
  // line rather than a silently thin package.
  if (envelopes.length === 0) {
    logInfo("sba_signed_pdfs_none_available", { applicationId });
    return [];
  }
  const out: Array<{ filename: string; content: Buffer }> = [];
  for (const envelope of envelopes) {
    try {
      if ((await getDocumentGroupStatus(envelope.groupId)).signed !== true) return [];
      for (const docId of envelope.docIds) {
        const content = await downloadDocument(docId);
        if (!content) return [];
        out.push({ filename: `sba-owner${envelope.ownerIndex}-${docId}.pdf`, content });
      }
    } catch {
      return [];
    }
  }
  return out;
}

/** File signed copies into the staff Documents list. Best effort. */
export async function attachSignedSbaDocuments(applicationId: string): Promise<{ attached: number }> {
  const pdfs = await getSignedSbaPdfs(applicationId);
  if (pdfs.length === 0) return { attached: 0 };
  let attached = 0;
  const storage = getStorage();
  for (const pdf of pdfs) {
    try {
      const existing = await dbQuery<{ id: string }>(
        `SELECT id FROM documents WHERE application_id::text = ($1)::text AND filename = $2 LIMIT 1`,
        [applicationId, pdf.filename],
      ).catch(() => ({ rows: [] as Array<{ id: string }> }));
      if (existing.rows.length > 0) continue;
      const stored = await storage.put({
        buffer: pdf.content,
        filename: pdf.filename,
        contentType: "application/pdf",
        pathPrefix: `sba/${applicationId}`,
      });
      const hash = createHash("sha256").update(pdf.content).digest("hex");
      const documentId = randomUUID();
      const versionId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category, storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, document_type, created_at, updated_at)
         VALUES ($1, ($2)::uuid, $3, $4, $5, $6, $6, $7, $8,
                 'accepted', 'skipped', 'system', 'sba_forms', now(), now())`,
          [documentId, applicationId, pdf.filename, hash, SBA_DOC_CATEGORY, stored.blobName, stored.url, stored.sizeBytes],
        );
        await client.query(
          `INSERT INTO document_versions
             (id, document_id, version, blob_name, hash, metadata, content, created_at)
           VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
          [versionId, documentId, stored.blobName, hash, JSON.stringify({ source: "signnow_sba" }), stored.url],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      attached += 1;
    } catch (error) {
      console.warn("[sba_attach]", applicationId, pdf.filename, error instanceof Error ? error.message : String(error));
    }
  }
  return { attached };
}
