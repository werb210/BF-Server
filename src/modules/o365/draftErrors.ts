// BF_SERVER_DRAFT_NOT_FOUND_v1
// Microsoft Graph answers a PATCH or GET against a draft item id that no longer
// exists in the mailbox with 404 ErrorItemNotFound. That happens routinely and
// innocently: the user sent the message from Outlook, Apple Mail or their phone,
// which consumes the Drafts item, or they deleted it by hand.
//
// Collapsing that into a generic 502 left the portal composer unable to tell
// "this draft is gone" from "Graph is broken", so its 25s autosave loop kept
// patching a dead id forever while still showing a stale "Saved" time for work
// it was no longer saving.
//
// Map it to 409 draft_not_found instead. The composer drops the stale id and
// stops autosaving. It deliberately does NOT recreate the draft: the usual
// reason the item is gone is that the message was already sent, and silently
// recreating it would put a phantom copy of a sent email back into Drafts.
export type DraftErrorResponse = {
  httpStatus: number;
  body: { error: string; detail: string };
};

export function draftErrorResponse(status: number, detail: string): DraftErrorResponse {
  if (status === 404 || String(detail ?? "").includes("ErrorItemNotFound")) {
    return { httpStatus: 409, body: { error: "draft_not_found", detail } };
  }
  if (status === 401 || status === 403) {
    return { httpStatus: 412, body: { error: "o365_insufficient_scope", detail } };
  }
  return { httpStatus: 502, body: { error: "graph_draft_failed", detail } };
}
