// KS_SERVER_LICENSEE_DOCUMENTS - matches each field on a licensee's document to the data Keystone collects.
// Words first (no network, always available); the AI, when it is set up, only looks at what the words left unmatched,
// and may only answer with a key from the catalogue. The licensee reviews every match before it is used.
import { DATA_FIELDS, DATA_FIELD_KEYS } from "./catalog.js";
import type { DocField } from "./readFields.js";

export type MatchedField = DocField & { mapped_to: string | null; matched_by: "words" | "ai" | "licensee" | null };

const norm = (t: string) => ` ${t.toLowerCase().replace(/[^a-z0-9%]+/g, " ").replace(/\s+/g, " ").trim()} `;
const OWNER2 = /\b(co[\s-]?applicant|co[\s-]?borrower|owner\s*2|second owner|partner|guarantor\s*2|2nd)\b/i;

/** The best catalogue key for one label by words, or null. Longest matching phrase wins. */
export function matchByWords(label: string, name = ""): string | null {
  const text = norm(`${label} ${name.replace(/([a-z])([A-Z])/g, "$1 $2")}`);
  const wantsOwner2 = OWNER2.test(label) || OWNER2.test(name);
  let best: { key: string; len: number } | null = null;
  for (const f of DATA_FIELDS) {
    if (f.key.startsWith("owner2.") && !wantsOwner2) continue;
    if (f.key.startsWith("owner1.") && wantsOwner2) continue;
    for (const w of f.words) {
      const phrase = norm(w);
      if (text.includes(phrase) && (!best || phrase.length > best.len)) best = { key: f.key, len: phrase.length };
    }
  }
  // A bare "date" or "name" is too weak on its own for anything but a short label.
  if (best && best.len <= 7 && norm(label).trim().split(" ").length > 3) return null;
  return best?.key ?? null;
}

type AskAi = (prompt: string) => Promise<string>;

async function defaultAskAi(prompt: string): Promise<string> {
  const { askAI } = await import("../modules/ai/openai.service.js");
  return askAI([{ role: "system", content: "You match form fields to data keys. Answer with JSON only." }, { role: "user", content: prompt }]);
}

export async function matchFields(fields: DocField[], ask: AskAi | null = process.env.OPENAI_API_KEY ? defaultAskAi : null): Promise<MatchedField[]> {
  const out: MatchedField[] = fields.map((f) => {
    if (f.type === "signature") return { ...f, mapped_to: null, matched_by: null };
    // A merge field named exactly as a catalogue key ({{offer.proceeds_fee}}) is that key: the words are not guessed at
    // ("Offer proceeds fee" would otherwise match the broker fee).
    const key = DATA_FIELD_KEYS.has(f.name) ? f.name : matchByWords(f.label, f.name);
    return { ...f, mapped_to: key, matched_by: key ? "words" : null };
  });
  const open = out.filter((f) => !f.mapped_to && f.type !== "signature");
  if (!open.length || !ask) return out;
  try {
    const catalogue = DATA_FIELDS.map((f) => `${f.key}: ${f.label}`).join("\n");
    const list = open.map((f) => `${f.name} | ${f.label}${f.options?.length ? ` | options: ${f.options.join(", ")}` : ""}`).join("\n");
    const raw = await ask(
      `Data keys:\n${catalogue}\n\nForm fields (name | label):\n${list}\n\n` +
      `For each form field give the one data key that holds the same information, or null when none does. ` +
      `Answer as a JSON object {"<field name>": "<data key>" | null}. Use only data keys from the list.`,
    );
    const json = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown>;
    for (const f of open) {
      const k = json[f.name];
      if (typeof k === "string" && DATA_FIELD_KEYS.has(k)) { f.mapped_to = k; f.matched_by = "ai"; }
    }
  } catch (err) {
    console.warn("[licensee-docs] AI matching skipped", { message: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

/** A wizard question's key from a document field name: lower case, letters, digits and underscores. */
export function questionKey(fieldName: string): string {
  return fieldName.toLowerCase().replace(/\[\d+\]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "question";
}
