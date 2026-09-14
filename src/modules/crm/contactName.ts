// BF_SERVER_PLACEHOLDER_NAME_v170
// Decides whether a contact's stored name should be replaced by the one the
// applicant supplied on submit.
//
// The wizard creates a draft contact as soon as a phone number is entered, so
// an abandoned application still keeps its journey. That draft is named
// "Unknown (application started)" because the real name is not known yet
// (src/routes/publicApplication.ts).
//
// On submit, applicationCrmMirror updated the row with
//   name = COALESCE(NULLIF(name,''), NULLIF($2,''))
// which only writes the new name when the existing one is EMPTY. The
// placeholder is not empty, so it survived forever: the CRM showed "Unknown
// (application started)" for an applicant whose real name was sitting on the
// same record.
//
// COALESCE was there to stop a blank submission wiping a good name, and that
// is still right. The missing case is that a placeholder is not a good name.

/** Names the wizard writes before it knows who the applicant is. */
const PLACEHOLDER_PATTERNS = [
  /\(application started\)/i,
  /^unknown$/i,
  /^unknown\s+\(/i,
];

export function isPlaceholderName(raw: unknown): boolean {
  const value = String(raw ?? "").trim();
  if (!value) return true; // empty is replaceable for the same reason
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * The name to store. A real incoming name replaces a placeholder; a blank or
 * placeholder incoming name never replaces a real one.
 */
export function resolveContactName(existing: unknown, incoming: unknown): string {
  const current = String(existing ?? "").trim();
  const next = String(incoming ?? "").trim();

  if (!next || isPlaceholderName(next)) return current;
  if (isPlaceholderName(current)) return next;
  return current;
}
