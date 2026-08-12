// BF_SERVER_INBOX_CID_REGEX_v43
// Pure helpers for resolving cid: image references in an email body against the
// message's Graph attachments. Kept free of Graph and of the database so the
// matching rules can be unit tested directly.
//
// The original regex was /cid:([^"'\\s)>]+)/gi. Inside a character class the
// doubled backslash is a literal backslash, so that class excluded the letter s
// and permitted whitespace - the opposite of the intent. Gmail content-ids are
// shaped like ii_ms8k2p9v0, so refs were cut at the first s and never matched.

export type CidAttachment = {
  id?: string | null;
  name?: string | null;
  contentId?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
  isInline?: boolean | null;
};

const MIN_PREFIX_MATCH = 6;

function norm(v: unknown): string {
  return String(v ?? "").trim().replace(/^<+/, "").replace(/>+$/, "");
}

function stripExtension(v: string): string {
  const dot = v.lastIndexOf(".");
  return dot > 0 ? v.slice(0, dot) : v;
}

// Every distinct cid: reference the body actually needs, in document order.
export function extractCidRefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /cid:([^"'\s)>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = norm(m[1]).replace(/[),;\]]+$/, "");
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function candidatesFor(att: CidAttachment): string[] {
  const cid = norm(att?.contentId);
  const name = norm(att?.name);
  const list = [cid, name, stripExtension(name), cid.split("@")[0]];
  return list.filter((v) => v.length > 0);
}

// Exact match first, then a prefix match in either direction so that a
// contentId/name mismatch (routine on Gmail-originated mail) still resolves.
export function matchCidAttachment(
  ref: string,
  attachments: CidAttachment[],
): CidAttachment | null {
  const wanted = [norm(ref), norm(ref).split("@")[0]].filter((v) => v.length > 0);
  if (wanted.length === 0) return null;

  for (const att of attachments) {
    for (const cand of candidatesFor(att)) {
      for (const want of wanted) {
        if (cand.toLowerCase() === want.toLowerCase()) return att;
      }
    }
  }

  for (const att of attachments) {
    for (const cand of candidatesFor(att)) {
      for (const want of wanted) {
        const a = cand.toLowerCase();
        const b = want.toLowerCase();
        if (a.length < MIN_PREFIX_MATCH || b.length < MIN_PREFIX_MATCH) continue;
        if (a.startsWith(b) || b.startsWith(a)) return att;
      }
    }
  }

  return null;
}

// Last resort for the common single-image signature case: one ref nobody
// claimed, one inline image nobody used.
export function soleUnusedInlineImage(
  attachments: CidAttachment[],
  usedIds: Set<string>,
): CidAttachment | null {
  const spare = attachments.filter((a) => {
    const id = String(a?.id ?? "");
    if (id.length > 0 && usedIds.has(id)) return false;
    const ctype = String(a?.contentType ?? "").toLowerCase();
    return a?.isInline === true || ctype.startsWith("image/");
  });
  return spare.length === 1 ? (spare[0] ?? null) : null;
}
