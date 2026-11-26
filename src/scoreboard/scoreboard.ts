// BF_SERVER_TV_SCOREBOARD_v1 - the sales scoreboard: this month's funded volume and deals funded per broker and per team,
// next to the Goals report's funding targets (report_goals), with each broker's movement since yesterday and the latest
// funded deals. It feeds the office TVs (Apple TV app) and the Leaderboard report. No client or company names ever leave
// here - visitors walk past these screens. Amounts are in CAD (USD deals converted with fx_rates, like the dashboard).
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type Funded = { id: string; broker: string | null; amount: number; funded_at: string; day: string };
export type Person = { user_id: string; name: string; photo_url: string | null; team_id: string | null; goal: number | null };
export type Team = { id: string; name: string; members: string[] };

export type BrokerRow = { user_id: string; name: string; initials: string; photo_url: string | null; team_id: string | null; team: string | null;
  volume: number; deals: number; goal: number | null; rank: number; movement: number };
export type TeamRow = { id: string; name: string; volume: number; deals: number; goal: number | null; brokers: number; rank: number };

export const SLIDES = ["leaderboard", "teams", "goal", "recent", "deals"] as const;

export function monthBounds(now: Date, tz: string): { month: string; start: string; end: string; today: string; label: string; days_left: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const y = g("year"), m = g("month"), d = g("day");
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
  return { month: `${y}-${pad(m)}`, start: `${y}-${pad(m)}-01`, end: next, today: `${y}-${pad(m)}-${pad(d)}`, label, days_left: last - d };
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

function rankBy<T extends { volume: number; deals: number; name: string }>(rows: T[]): Map<T, number> {
  const sorted = [...rows].sort((a, b) => b.volume - a.volume || b.deals - a.deals || a.name.localeCompare(b.name));
  const out = new Map<T, number>();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    out.set(r, prev && prev.volume === r.volume && prev.deals === r.deals ? out.get(prev)! : i + 1);
  });
  return out;
}

/** Pure: the brokers and teams, ranked. A broker shows when they have a goal, a funded deal or a team on this board. */
export function computeBoard(input: { people: Person[]; teams: Team[]; funded: Funded[]; today: string; teamIds: string[] | null }) {
  const onBoard = (p: Person) => !input.teamIds || (p.team_id !== null && input.teamIds.includes(p.team_id));
  const teams = input.teams.filter((t) => !input.teamIds || input.teamIds.includes(t.id));
  const teamName = new Map(input.teams.map((t) => [t.id, t.name]));
  const people = input.people.filter(onBoard);
  const ids = new Set(people.map((p) => p.user_id));
  const funded = input.funded.filter((f) => f.broker && ids.has(f.broker));
  const sum = (rows: Funded[], who: string) => rows.filter((f) => f.broker === who).reduce((s, f) => s + f.amount, 0);
  const count = (rows: Funded[], who: string) => rows.filter((f) => f.broker === who).length;
  const before = funded.filter((f) => f.day < input.today);
  const shown = people.filter((p) => p.goal !== null || p.team_id !== null || count(funded, p.user_id) > 0);
  const now = shown.map((p) => ({ p, name: p.name, volume: Math.round(sum(funded, p.user_id)), deals: count(funded, p.user_id) }));
  const then = shown.map((p) => ({ p, name: p.name, volume: Math.round(sum(before, p.user_id)), deals: count(before, p.user_id) }));
  const rNow = rankBy(now), rThen = rankBy(then);
  const thenRank = new Map([...rThen].map(([r, n]) => [r.p.user_id, n]));
  const brokers: BrokerRow[] = now.map((r) => {
    const rank = rNow.get(r)!;
    const yesterday = thenRank.get(r.p.user_id) ?? rank;
    return { user_id: r.p.user_id, name: r.p.name, initials: initials(r.p.name), photo_url: r.p.photo_url, team_id: r.p.team_id,
      team: r.p.team_id ? teamName.get(r.p.team_id) ?? null : null, volume: r.volume, deals: r.deals, goal: r.p.goal, rank, movement: yesterday - rank };
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const teamRows = teams.map((t) => {
    const members = brokers.filter((b) => b.team_id === t.id);
    const goals = members.map((m) => m.goal).filter((g): g is number => g !== null);
    return { id: t.id, name: t.name, volume: members.reduce((s, m) => s + m.volume, 0), deals: members.reduce((s, m) => s + m.deals, 0),
      goal: goals.length ? goals.reduce((s, g) => s + g, 0) : null, brokers: members.length };
  });
  const tRank = rankBy(teamRows);
  const teamsOut: TeamRow[] = teamRows.map((t) => ({ ...t, rank: tRank.get(t)! })).sort((a, b) => a.rank - b.rank);
  const goals = brokers.map((b) => b.goal).filter((g): g is number => g !== null);
  const office = { volume: brokers.reduce((s, b) => s + b.volume, 0), deals: brokers.reduce((s, b) => s + b.deals, 0), goal: goals.length ? goals.reduce((s, g) => s + g, 0) : null };
  const nameOf = new Map(brokers.map((b) => [b.user_id, b]));
  const recent = [...funded].sort((a, b) => b.funded_at.localeCompare(a.funded_at)).slice(0, 10).map((f) => {
    const b = nameOf.get(f.broker!);
    return { id: f.id, broker: b?.name ?? "", initials: b?.initials ?? "", photo_url: b?.photo_url ?? null, team: b?.team ?? null, amount: Math.round(f.amount), funded_at: f.funded_at };
  });
  return { brokers, teams: teamsOut, office, recent };
}

const NAME = `COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'Broker')`;

/** Reads this month and builds the board. dealCurrencySql is the dashboard's DEAL_CURRENCY_SQL (it reads a and lp). */
export async function loadBoard(db: Q, opts: { tz: string; now?: Date; teamIds?: string[] | null; dealCurrencySql: string }) {
  const b = monthBounds(opts.now ?? new Date(), opts.tz);
  const funded = (await db.query(
    `SELECT a.id::text AS id, COALESCE(dc.broker_user_id, a.owner_user_id)::text AS broker,
            to_char(a.funded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS funded_at, (a.funded_at AT TIME ZONE $3)::date::text AS day,
            (COALESCE(a.funded_amount, 0) * COALESCE((SELECT to_cad FROM fx_rates WHERE currency = ${opts.dealCurrencySql}), 1))::float AS amount
       FROM applications a
       LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
       LEFT JOIN deal_closes dc ON dc.application_id = a.id::text
      WHERE UPPER(COALESCE(a.silo, 'BF')) = 'BF' AND a.funded_at IS NOT NULL
        AND (a.funded_at AT TIME ZONE $3)::date >= $1::date AND (a.funded_at AT TIME ZONE $3)::date < $2::date
        AND COALESCE(a.pipeline_state, '') <> 'Fraud'`,
    [b.start, b.end, opts.tz],
  )).rows.map((r: any) => ({ id: r.id, broker: r.broker, amount: Number(r.amount) || 0, funded_at: r.funded_at, day: r.day }));
  const teams = (await db.query(
    `SELECT t.id::text AS id, t.name, COALESCE(array_agg(m.user_id::text) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
       FROM sales_teams t LEFT JOIN sales_team_members m ON m.team_id = t.id
      WHERE t.archived_at IS NULL GROUP BY t.id, t.name ORDER BY lower(t.name)`,
  )).rows as Team[];
  const people = (await db.query(
    `SELECT u.id::text AS user_id, ${NAME} AS name, u.profile_image_url AS photo_url,
            COALESCE(u.primary_team_id::text, (SELECT m.team_id::text FROM sales_team_members m JOIN sales_teams t ON t.id = m.team_id AND t.archived_at IS NULL
                                                WHERE m.user_id = u.id ORDER BY lower(t.name) LIMIT 1)) AS team_id,
            (SELECT g.funding_target::float FROM report_goals g WHERE g.user_id = u.id AND g.month = $1::date) AS goal
       FROM users u
      WHERE COALESCE(u.disabled, false) = false AND COALESCE(u.status, 'ACTIVE') = 'ACTIVE'
        AND u.role IN ('Admin', 'Staff', 'Ops')`,
    [b.start],
  )).rows.map((r: any) => ({ user_id: r.user_id, name: r.name, photo_url: r.photo_url ?? null, team_id: r.team_id ?? null, goal: r.goal === null || r.goal === undefined ? null : Number(r.goal) }));
  const board = computeBoard({ people, teams, funded, today: b.today, teamIds: opts.teamIds ?? null });
  return { period: { month: b.month, label: b.label, days_left: b.days_left }, currency: "CAD", ...board, generated_at: (opts.now ?? new Date()).toISOString() };
}
