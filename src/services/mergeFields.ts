// BF_SERVER_SNIPPETS_v65
// Merge fields for snippets and templates. Deliberately small: a fixed set of
// names resolved from data we already hold, no expression language, no
// conditionals. A snippet is text with holes in it, not a program.
//
// Unknown fields are left EXACTLY as written rather than blanked. If someone
// types {{contact.nickname}} and we cannot resolve it, they see the mistake in
// the composer instead of sending a message with a hole where a name should be.
export type MergeContext = {
  contact?: {
    name?: string | null;
    first_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  company?: { name?: string | null } | null;
  user?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  application?: { id?: string | null; requested_amount?: string | number | null } | null;
};

// The field name a person types -> where the value comes from.
export const MERGE_FIELDS: Record<string, (c: MergeContext) => string | null> = {
  "contact.name": (c) => c.contact?.name ?? null,
  // A first name is what you actually want in "Hi {{contact.first_name}}".
  // Falls back to the first word of the full name when it is not stored.
  "contact.first_name": (c) =>
    c.contact?.first_name
    ?? (c.contact?.name ? String(c.contact.name).trim().split(/\s+/)[0] ?? null : null),
  "contact.email": (c) => c.contact?.email ?? null,
  "contact.phone": (c) => c.contact?.phone ?? null,
  "company.name": (c) => c.company?.name ?? null,
  "user.name": (c) => c.user?.name ?? null,
  "user.email": (c) => c.user?.email ?? null,
  "user.phone": (c) => c.user?.phone ?? null,
  "application.amount": (c) =>
    c.application?.requested_amount != null ? String(c.application.requested_amount) : null,
};

export const MERGE_FIELD_NAMES = Object.keys(MERGE_FIELDS);

const TOKEN = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi;

export function renderMergeFields(text: string, ctx: MergeContext): string {
  if (!text) return text;
  return text.replace(TOKEN, (whole, name: string) => {
    const resolver = MERGE_FIELDS[String(name).toLowerCase()];
    if (!resolver) return whole; // unknown field: leave it visible
    const value = resolver(ctx);
    // A known field with no value also stays as written, so the sender sees
    // that the contact has no company rather than sending "Hi from ".
    return value != null && String(value).trim() !== "" ? String(value) : whole;
  });
}

// Which fields a given text uses - lets the composer warn before sending.
// BF_SERVER_MERGE_ON_SEND_v67
// Cheap test before paying for a lookup. Most messages contain no tokens.
export function hasMergeFields(text: string): boolean {
  return /\{\{\s*[a-z_]+\.[a-z_]+\s*\}\}/i.test(String(text ?? ""));
}

export function usedMergeFields(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(TOKEN)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

export function unresolvedMergeFields(text: string, ctx: MergeContext): string[] {
  return usedMergeFields(text).filter((name) => {
    const resolver = MERGE_FIELDS[name];
    if (!resolver) return true;
    const value = resolver(ctx);
    return value == null || String(value).trim() === "";
  });
}
