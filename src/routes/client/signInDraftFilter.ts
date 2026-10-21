// BF_SERVER_v838_SIGNIN_SKIPS_UNSUBMITTED - which applications sign-in may open in the client portal.
//
// The wizard creates the client's application at 'Received' (not 'draft') the moment they start, so the sign-in
// lookup (GET /api/client/applications/by-phone without includeDrafts) found an unfinished one and opened the
// client portal on a form that was never sent: "You're all caught up". Applications the client started in the
// wizard (source client_direct or readiness_continuation) and never submitted are left out, so sign-in carries on
// to the wizard. Files staff created or imported for the client are not affected.
export const UNSUBMITTED_CLIENT_DRAFT_EXCLUSION =
  "AND NOT (a.submitted_at IS NULL AND lower(coalesce(a.source, '')) IN ('client_direct', 'readiness_continuation'))";
