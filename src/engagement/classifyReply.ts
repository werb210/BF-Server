// BF_SERVER_ENGAGEMENT_v1 - what kind of reply this is, from its subject and opening lines. Rules, not a model: quick,
// free and predictable, and staff can change the label on the contact. The same file lives in BI-Server for PGI.
export type ReplyKind = "interested" | "question" | "not_now" | "not_interested" | "wrong_person" | "unsubscribe" | "other";

export const REPLY_KIND_LABEL: Record<ReplyKind, string> = {
  interested: "Interested",
  question: "Question",
  not_now: "Not now",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
  unsubscribe: "Unsubscribe",
  other: "Reply",
};

const has = (t: string, words: RegExp) => words.test(t);

/** The reply's own words: quoted history ("On ... wrote:", "From:", "> ") and signatures are cut off. */
export function replyBody(raw: unknown, max = 600): string {
  let t = String(raw ?? "").replace(/\r/g, "");
  const cut = t.search(/\n\s*(On .{0,200}wrote:|-{2,}\s*Original Message|From:\s|Sent from my |________________)/i);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

export function classifyReply(subject: unknown, body: unknown): ReplyKind {
  const t = `${String(subject ?? "")}\n${replyBody(body)}`.toLowerCase();
  if (has(t, /\b(unsubscribe|remove me|take me off|stop (emailing|sending|contacting)|do not (email|contact)|don't (email|contact)|opt(ed)? out)\b/)) return "unsubscribe";
  if (has(t, /\b(no longer (with|at|work)|not the (right|correct) (person|contact)|wrong (person|contact)|you (should|may want to|might want to) (contact|reach|speak)|please (contact|reach out to)|i've (left|retired)|has left)\b/)) return "wrong_person";
  if (has(t, /\b(not interested|no thanks|no thank you|we('| a)re (all set|good|covered)|we already have|not a fit|pass on this|no need)\b/)) return "not_interested";
  if (has(t, /\b(not (right )?now|not at this time|maybe later|reach out (again )?(in|next)|check back|circle back|follow up (in|next)|next (quarter|year|month)|after the (holidays|new year))\b/)) return "not_now";
  if (has(t, /\b(interested|sounds (good|great|interesting)|tell me more|more (info|information|details)|let'?s (talk|chat|connect|meet)|set up a (call|time|meeting)|book a (call|time)|happy to (chat|talk|meet)|call me|give me a call|send (me )?(over )?(the )?(details|info|information))\b/)) return "interested";
  if (t.includes("?")) return "question";
  return "other";
}

/** Replies that end the follow-up: nothing more to chase. */
export function closesFollowUp(kind: ReplyKind): boolean {
  return kind === "unsubscribe" || kind === "not_interested";
}
