// BF_SERVER_v869_PHONE_MENU - the 866 phone menu (IVR) as data, edited by an Admin in Settings > Phone menu.
// Ported from KS-server #38 (BF_SERVER_v869_SETTINGS_PACK_PHONE_MENU) and extended so Boreal's live menu is expressed exactly:
//
//   greeting            text read aloud (Polly, or Maya's nova voice when RECEPTION_NOVA_VOICE=true), or a recording
//   options             each has a key 1-9 (or none: "spoken only", for example "Caden" or "where are you"), the words a
//                       caller can say instead of pressing it, and where it goes:
//     submenu           a second menu with its own prompt and options (Boreal Financial: engagement / credit)
//     user              one person: their apps, then their opted-in Watch cell; their call hours and Busy switch apply
//     group             several people at once (or one at a time); "everyone else who is available" rings every free
//                       staff member too, except the people listed as never in the group
//     voicemail         a person's private voicemail, or the shared voicemail, after an optional message
//     ai                the AI receptionist: the caller says what they need and is sent to the matching option
//     meeting           the meeting dial-in (six-digit access code)
//   when nothing fits   ask once more (optional), then the chosen option
//   hours + holidays    Alberta time (UTC-6 all year); outside them the after-hours greeting and choice
//   no answer           where a call goes when nobody picks up (default: the person's own voicemail; the shared
//                       voicemail for a group)
//
// With no menu saved, defaultBorealMenu() is used: the menu callers hear today, unchanged (see the test
// phoneMenu.v869.test.ts). Pure: no database or Twilio here (./store.ts, routes/reception.ts).
import { zonedDay, zonedParts } from "../settingsPack/boreal.js";

export const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type Digit = (typeof DIGITS)[number];
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** Reception roles from before the menu was data: RECEPTION_SALES_USER_ID / RECEPTION_UNDERWRITING_USER_ID when set,
 *  else the active user whose first name is exactly Todd / Andrew. Only the default menu uses them. */
export const ROLE_REFS = ["@sales", "@underwriting"] as const;
export type RoleRef = (typeof ROLE_REFS)[number];
export const isRoleRef = (v: unknown): v is RoleRef => (ROLE_REFS as readonly string[]).includes(String(v));

export type MenuTarget =
  | { type: "user"; userId: string; name: string }
  | { type: "group"; userIds: string[]; strategy: "simultaneous" | "sequential"; everyoneAvailable: boolean; exceptUserIds: string[] }
  /** userId null: the person who was being rung, else the shared mailbox. message: said before the voicemail prompt. */
  | { type: "voicemail"; userId: string | null; message: string }
  | { type: "ai" }
  | { type: "meeting" }
  | { type: "submenu"; menu: SubMenu };

export type Prompt = { mode: "tts" | "audio"; text: string; audioId: string | null };

export type MenuOption = { id: string; digit: Digit | null; label: string; keywords: string[]; target: MenuTarget };

export type NoChoice = { retry: boolean; optionId: string | null };

export type SubMenu = { prompt: Prompt; announceOptions: boolean; retryPrompt: string; options: MenuOption[]; whenNoChoice: NoChoice };

export type PhoneMenu = {
  greeting: Prompt;
  /** Read "For sales, press 1..." after the greeting, built from the option labels. */
  announceOptions: boolean;
  hours: { enabled: boolean; weekly: Record<DayKey, Array<[string, string]>> };
  afterHoursGreeting: Prompt;
  afterHours: MenuTarget;
  options: MenuOption[];
  whenNoChoice: NoChoice;
  noAnswer: { ringSeconds: number; target: MenuTarget };
  holidays: Array<{ date: string; name: string }>;
};

export type MenuUser = { id: string; first_name: string | null; last_name: string | null; role?: string | null };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTION_ID = /^[A-Za-z0-9_-]{1,24}$/;
export const MAX_TEXT = 600;
export const MAX_HOLIDAYS = 60;
export const DEFAULT_RING_SECONDS = 25;

export function displayName(u: Pick<MenuUser, "first_name" | "last_name">): string {
  return [u.first_name, u.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || "a team member";
}

function weekdays(): PhoneMenu["hours"]["weekly"] {
  const work: Array<[string, string]> = [["09:00", "17:00"]];
  return { sun: [], mon: [...work], tue: [...work], wed: [...work], thu: [...work], fri: [...work], sat: [] };
}

const tts = (text: string): Prompt => ({ mode: "tts", text, audioId: null });

/** Boreal's live 866 menu (wording approved by Todd 2026-10-01; meeting rooms on 3 since v736). */
export function defaultBorealMenu(): PhoneMenu {
  return {
    greeting: tts("This call may be recorded. Thank you for calling the Boreal Group of Companies. Are you looking for Boreal Financial, or Boreal Risk Management? You can say it, or press 1 for Financial, 2 for Risk Management. To join a scheduled meeting, press 3."),
    announceOptions: false,
    hours: { enabled: false, weekly: weekdays() },
    afterHoursGreeting: tts("Thank you for calling the Boreal Group of Companies. Our office is closed right now."),
    afterHours: { type: "voicemail", userId: null, message: "" },
    options: [
      {
        id: "BF", digit: "1", label: "Boreal Financial", keywords: ["financ", "finance", "loan", "funding", "bf"],
        target: {
          type: "submenu",
          menu: {
            prompt: tts("Thank you for contacting Boreal Financial. For client engagement, press 1. For credit, press 2."),
            announceOptions: false,
            retryPrompt: "Sorry, I didn't catch that. For client engagement, press 1. For credit, press 2.",
            options: [
              { id: "caden", digit: null, label: "Caden", keywords: ["caden"], target: { type: "voicemail", userId: null, message: "Let me take a message for the team." } },
              {
                id: "address", digit: null, label: "Our address", keywords: ["address", "location", "where are you", "directions"],
                target: { type: "voicemail", userId: null, message: "You can reach us through the contact form on our website. I can also take your details and notify the team." },
              },
              {
                id: "engagement", digit: "1", label: "client engagement",
                keywords: ["client", "engag", "todd", "sales", "apply", "new", "financ", "funding", "loan", "quote", "get started"],
                target: { type: "group", userIds: ["@sales"], strategy: "simultaneous", everyoneAvailable: true, exceptUserIds: ["@underwriting"] },
              },
              {
                id: "underwriting", digit: "2", label: "credit",
                keywords: ["credit", "andrew", "underwrit", "document", "condition", "approval", "declin", "status", "lender"],
                target: { type: "user", userId: "@underwriting", name: "Andrew" },
              },
            ],
            whenNoChoice: { retry: true, optionId: "engagement" },
          },
        },
      },
      { id: "sales", digit: "2", label: "Boreal Risk Management", keywords: ["risk", "insurance", "brm", "management"], target: { type: "user", userId: "@sales", name: "Todd" } },
      { id: "meeting", digit: "3", label: "a scheduled meeting", keywords: ["meeting", "conference"], target: { type: "meeting" } },
    ],
    whenNoChoice: { retry: false, optionId: "BF" },
    noAnswer: { ringSeconds: DEFAULT_RING_SECONDS, target: { type: "voicemail", userId: null, message: "" } },
    holidays: [],
  };
}

// ------------------------------------------------------------------ walking the menu
/** Every option, top level first, then each submenu's. */
export function allOptions(menu: Pick<PhoneMenu, "options">): MenuOption[] {
  const out: MenuOption[] = [];
  for (const o of menu.options) {
    out.push(o);
    if (o.target.type === "submenu") out.push(...o.target.menu.options);
  }
  return out;
}

export function findOption(menu: Pick<PhoneMenu, "options">, id: string): MenuOption | null {
  return allOptions(menu).find((o) => o.id === id) ?? null;
}

/** Every user reference a target holds (ids or role refs). */
export function targetUserRefs(t: MenuTarget): string[] {
  if (t.type === "user") return [t.userId];
  if (t.type === "group") return [...t.userIds, ...t.exceptUserIds];
  if (t.type === "voicemail") return t.userId ? [t.userId] : [];
  if (t.type === "submenu") return t.menu.options.flatMap((o) => targetUserRefs(o.target));
  return [];
}

/** Replaces role refs (@sales / @underwriting) with real user ids, for the editor (refs that resolve to nobody stay). */
export function resolveRoleRefs(menu: PhoneMenu, ids: Partial<Record<RoleRef, string | null>>): PhoneMenu {
  const r = (v: string) => (isRoleRef(v) ? ids[v] ?? v : v);
  const fix = (t: MenuTarget): MenuTarget => {
    if (t.type === "user") return { ...t, userId: r(t.userId) };
    if (t.type === "group") return { ...t, userIds: t.userIds.map(r), exceptUserIds: t.exceptUserIds.map(r) };
    if (t.type === "voicemail") return { ...t, userId: t.userId ? r(t.userId) : null };
    if (t.type === "submenu") return { type: "submenu", menu: { ...t.menu, options: t.menu.options.map((o) => ({ ...o, target: fix(o.target) })) } };
    return t;
  };
  return { ...menu, afterHours: fix(menu.afterHours), noAnswer: { ...menu.noAnswer, target: fix(menu.noAnswer.target) }, options: menu.options.map((o) => ({ ...o, target: fix(o.target) })) };
}

// ------------------------------------------------------------------ validation
type Errors = Record<string, string>;
const str = (v: unknown): string => String(v ?? "").trim();

function checkPrompt(raw: unknown, key: string, errors: Errors, audioIds: Set<string>, required = true): Prompt {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = r.mode === "audio" ? "audio" : "tts";
  const text = str(r.text);
  const audioId = r.audioId == null || r.audioId === "" ? null : str(r.audioId);
  if (text.length > MAX_TEXT) errors[`${key}.text`] = `Keep it under ${MAX_TEXT} characters.`;
  if (mode === "tts" && !text && required) errors[`${key}.text`] = "Enter the words to read to callers.";
  if (mode === "audio" && (!audioId || !audioIds.has(audioId))) errors[`${key}.audioId`] = "Upload a recording, or switch to reading text aloud.";
  return { mode, text, audioId: mode === "audio" ? audioId : null };
}

type Ctx = { users: Set<string>; audio: Set<string>; ids: Set<string> };

function checkTarget(raw: unknown, key: string, errors: Errors, ctx: Ctx, allow: MenuTarget["type"][], depth: number): MenuTarget {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const type = str(r.type) as MenuTarget["type"];
  if (!allow.includes(type)) {
    errors[key] = "Choose where this goes.";
    return { type: "voicemail", userId: null, message: "" };
  }
  const known = (id: string) => ctx.users.has(id);
  if (type === "user") {
    const id = str(r.userId);
    if (!known(id)) errors[key] = "Choose an active team member.";
    const name = str(r.name).slice(0, 60);
    if (!name) errors[`${key}.name`] = "Enter the name callers hear (for example: Todd).";
    return { type, userId: id, name };
  }
  if (type === "group") {
    const ids = Array.isArray(r.userIds) ? Array.from(new Set(r.userIds.map(str).filter(Boolean))) as string[] : [];
    const except = Array.isArray(r.exceptUserIds) ? Array.from(new Set(r.exceptUserIds.map(str).filter(Boolean))) as string[] : [];
    const everyoneAvailable = r.everyoneAvailable === true;
    if (!ids.length && !everyoneAvailable) errors[key] = "Choose at least one person for the group.";
    else if ([...ids, ...except].some((id) => !known(id))) errors[key] = "Every person in the group must be an active team member.";
    else if (ids.length > 10) errors[key] = "A group can ring at most 10 people.";
    const strategy = r.strategy === "sequential" ? "sequential" : "simultaneous";
    if (strategy === "sequential" && everyoneAvailable) errors[key] = "One at a time works with the people listed only.";
    return { type, userIds: ids, strategy, everyoneAvailable, exceptUserIds: everyoneAvailable ? except : [] };
  }
  if (type === "voicemail") {
    const id = r.userId == null || r.userId === "" ? null : str(r.userId);
    if (id && !known(id)) errors[key] = "Choose an active team member's voicemail, or the shared voicemail.";
    const message = str(r.message);
    if (message.length > MAX_TEXT) errors[`${key}.message`] = `Keep it under ${MAX_TEXT} characters.`;
    return { type, userId: id, message };
  }
  if (type === "submenu") {
    if (depth > 0) { errors[key] = "A second menu cannot hold another menu."; return { type: "voicemail", userId: null, message: "" }; }
    const m = (r.menu && typeof r.menu === "object" ? r.menu : {}) as Record<string, any>;
    const prompt = checkPrompt(m.prompt, `${key}.prompt`, errors, ctx.audio);
    const retryPrompt = str(m.retryPrompt).slice(0, MAX_TEXT);
    const options = checkOptions(m.options, `${key}.options`, errors, ctx, depth + 1);
    const whenNoChoice = checkNoChoice(m.whenNoChoice, `${key}.whenNoChoice`, errors, options);
    if (!options.length) errors[`${key}.options`] = "Add at least one option to this menu.";
    return { type, menu: { prompt, announceOptions: m.announceOptions === true, retryPrompt, options, whenNoChoice } };
  }
  return { type } as MenuTarget;
}

function checkNoChoice(raw: unknown, key: string, errors: Errors, options: MenuOption[]): NoChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const optionId = r.optionId == null || r.optionId === "" ? null : str(r.optionId);
  if (optionId && !options.some((o) => o.id === optionId)) errors[key] = "Choose one of this menu's options.";
  return { retry: r.retry === true, optionId };
}

function checkOptions(raw: unknown, key: string, errors: Errors, ctx: Ctx, depth: number): MenuOption[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > 12) errors[key] = "A menu can have at most 12 options (9 keys and 3 spoken only).";
  const seen = new Set<string>();
  const out: MenuOption[] = [];
  const allow: MenuTarget["type"][] = depth === 0 ? ["user", "group", "voicemail", "ai", "meeting", "submenu"] : ["user", "group", "voicemail", "ai", "meeting"];
  list.slice(0, 12).forEach((o: any, i: number) => {
    const k = `${key}.${i}`;
    const id = str(o?.id);
    if (!OPTION_ID.test(id)) errors[`${k}.id`] = "Each option needs a short id (letters and numbers).";
    else if (ctx.ids.has(id)) errors[`${k}.id`] = `The id ${id} is used twice.`;
    ctx.ids.add(id);
    const rawDigit = o?.digit == null || o?.digit === "" ? null : str(o.digit);
    let digit: Digit | null = null;
    if (rawDigit !== null) {
      if (!(DIGITS as readonly string[]).includes(rawDigit)) errors[`${k}.digit`] = "Choose a key from 1 to 9.";
      else if (seen.has(rawDigit)) errors[`${k}.digit`] = `Key ${rawDigit} is used twice.`;
      else digit = rawDigit as Digit;
      seen.add(rawDigit);
    }
    const label = str(o?.label);
    if (!label) errors[`${k}.label`] = "Say what this option is for (for example: credit).";
    if (label.length > 80) errors[`${k}.label`] = "Keep the label under 80 characters.";
    const keywords = (Array.isArray(o?.keywords) ? o.keywords : String(o?.keywords ?? "").split(","))
      .map((x: unknown) => str(x).toLowerCase()).filter(Boolean).slice(0, 15);
    if (digit === null && !keywords.length) errors[`${k}.keywords`] = "An option without a key needs words callers can say.";
    out.push({ id, digit, label, keywords, target: checkTarget(o?.target, `${k}.target`, errors, ctx, allow, depth) });
  });
  return out;
}

function checkWeekly(raw: unknown, errors: Errors): PhoneMenu["hours"]["weekly"] {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as PhoneMenu["hours"]["weekly"];
  for (const d of DAY_KEYS) {
    const ranges = Array.isArray(src[d]) ? (src[d] as unknown[]) : [];
    out[d] = [];
    for (const r of ranges.slice(0, 3)) {
      const [a, b] = Array.isArray(r) ? r.map(str) : ["", ""];
      if (!HHMM.test(a ?? "") || !HHMM.test(b ?? "") || a! >= b!) { errors[`hours.${d}`] = "Use times like 09:00 to 17:00 (start before end)."; continue; }
      out[d].push([a!, b!]);
    }
  }
  return out;
}

/** Checks an edited menu against the active users and uploaded recordings. Role refs (@sales / @underwriting) are
 *  accepted only when they still resolve (the caller passes them in userIds). */
export function validateMenu(raw: unknown, ctx: { userIds: Iterable<string>; audioIds: Iterable<string> }):
  { ok: true; value: PhoneMenu } | { ok: false; errors: Errors } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const errors: Errors = {};
  const c: Ctx = { users: new Set(ctx.userIds), audio: new Set(ctx.audioIds), ids: new Set() };
  const greeting = checkPrompt(r.greeting, "greeting", errors, c.audio);
  const afterHoursGreeting = checkPrompt(r.afterHoursGreeting, "afterHoursGreeting", errors, c.audio);
  const hours = { enabled: r.hours?.enabled === true, weekly: checkWeekly(r.hours?.weekly, errors) };
  const afterHours = checkTarget(r.afterHours ?? { type: "voicemail", userId: null }, "afterHours", errors, c, ["user", "group", "voicemail", "ai"], 1);
  const options = checkOptions(r.options, "options", errors, c, 0);
  const whenNoChoice = checkNoChoice(r.whenNoChoice, "whenNoChoice", errors, options);
  const ringSeconds = Math.round(Number(r.noAnswer?.ringSeconds ?? DEFAULT_RING_SECONDS));
  if (!Number.isFinite(ringSeconds) || ringSeconds < 10 || ringSeconds > 60) errors["noAnswer.ringSeconds"] = "Ring for 10 to 60 seconds.";
  const noAnswer = {
    ringSeconds: Number.isFinite(ringSeconds) ? Math.min(60, Math.max(10, ringSeconds)) : DEFAULT_RING_SECONDS,
    target: checkTarget(r.noAnswer?.target ?? { type: "voicemail", userId: null }, "noAnswer.target", errors, c, ["user", "group", "voicemail"], 1),
  };
  const holidays: PhoneMenu["holidays"] = [];
  const rawHolidays = Array.isArray(r.holidays) ? r.holidays : [];
  if (rawHolidays.length > MAX_HOLIDAYS) errors.holidays = `At most ${MAX_HOLIDAYS} holidays.`;
  rawHolidays.slice(0, MAX_HOLIDAYS).forEach((h: any, i: number) => {
    const date = str(h?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) { errors[`holidays.${i}`] = "Use a date like 2026-12-25."; return; }
    holidays.push({ date, name: str(h?.name).slice(0, 80) || "Holiday" });
  });
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { greeting, announceOptions: r.announceOptions === true, hours, afterHoursGreeting, afterHours, options, whenNoChoice, noAnswer, holidays } };
}

// ------------------------------------------------------------------ what callers hear
/** Is the office open at `now` (Alberta time)? Hours off = always open, except on a holiday. */
export function officeOpen(menu: PhoneMenu, now: Date): { open: boolean; holiday: string | null } {
  const day = zonedDay(now);
  const holiday = menu.holidays.find((h) => h.date === day);
  if (holiday) return { open: false, holiday: holiday.name };
  if (!menu.hours.enabled) return { open: true, holiday: null };
  const p = zonedParts(now);
  const m = p.hour * 60 + p.minute;
  const ranges = menu.hours.weekly[DAY_KEYS[p.dow]!] ?? [];
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return { open: ranges.some(([a, b]) => m >= toMin(a) && m < toMin(b)), holiday: null };
}

/** "For credit, press 2." for every option with a key. */
export function optionsPrompt(options: MenuOption[]): string {
  return options.filter((o) => o.digit).sort((a, b) => a.digit!.localeCompare(b.digit!)).map((o) => `For ${o.label}, press ${o.digit}.`).join(" ");
}

/** The words read with a prompt: its text (when read aloud), then the options when announced. */
export function promptText(prompt: Prompt, options: MenuOption[], announce: boolean): string {
  return [prompt.mode === "tts" ? prompt.text : "", announce ? optionsPrompt(options) : ""].filter(Boolean).join(" ");
}

/** True when a caller's words contain a keyword: words of 3 letters or fewer ("bf", "new") must be said on their own;
 *  longer ones may start or sit inside a word ("financ" matches "financing"). */
export function saidKeyword(said: string, keyword: string): boolean {
  const k = String(keyword ?? "").toLowerCase().trim();
  if (!k) return false;
  if (k.length <= 3) return new RegExp(`(^|[^a-z0-9])${k.replace(/[^a-z0-9 ]/g, "")}($|[^a-z0-9])`).test(said);
  return said.includes(k);
}

/**
 * The option a caller chose: the key pressed, else the words said. Options without a key are checked first (in order),
 * then keyed options from the highest key down, so "credit for a new loan" goes to credit (2) as it always has.
 */
export function chooseOption(options: MenuOption[], digit: string, speech: string, opts: { exclude?: MenuTarget["type"][] } = {}): MenuOption | null {
  const candidates = options.filter((o) => !(opts.exclude ?? []).includes(o.target.type));
  const said = String(speech ?? "").toLowerCase();
  if (said.trim()) {
    for (const o of candidates.filter((x) => !x.digit)) if (o.keywords.some((k) => saidKeyword(said, k))) return o;
  }
  if (digit) {
    const byKey = candidates.find((o) => o.digit === digit);
    if (byKey) return byKey;
  }
  if (!said.trim()) return null;
  const keyed = candidates.filter((x) => x.digit).sort((a, b) => b.digit!.localeCompare(a.digit!));
  for (const o of keyed) if (o.keywords.some((k) => saidKeyword(said, k))) return o;
  return null;
}

/** People listed in the menu who are no longer active (the editor flags them). Role refs are skipped. */
export function staleUserIds(menu: PhoneMenu, activeIds: Set<string>): string[] {
  const refs = [...allOptions(menu).flatMap((o) => (o.target.type === "submenu" ? [] : targetUserRefs(o.target))), ...targetUserRefs(menu.afterHours), ...targetUserRefs(menu.noAnswer.target)];
  return Array.from(new Set(refs.filter((id) => !isRoleRef(id) && UUID.test(id) && !activeIds.has(id))));
}
