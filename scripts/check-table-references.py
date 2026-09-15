#!/usr/bin/env python3
"""BF_SERVER_TABLE_REFERENCE_GUARDRAIL_v227

Fails CI when a query names a table the migrations never create.

Four features died this way before anyone noticed, all in one 40-line file:
the watch complication read user_presence (the table is staff_presence), counted
call_logs.user_id (the column is staff_user_id) and counted crm_tasks (retired).
Each was wrapped in a .catch that turned the error into an empty result, so a
typo looked exactly like "nothing to show" - for months.

This is the cheap half of that problem: a name that does not exist at all is
decidable from the repo, in under a second, with no database.

Column names are NOT checked - that needs a live schema. The silent-query
guardrail (check-silent-queries.py) is the backstop for those.
"""
import json
import pathlib
import re
import sys

BASELINE = pathlib.Path("scripts/table-references-baseline.json")

# Things that look like a table in a FROM/JOIN but are not one.
NOT_TABLES = {
    "information_schema", "unnest", "generate_series", "jsonb_array_elements",
    "jsonb_each", "lateral", "json_array_elements", "jsonb_to_recordset",
    # Google Ads API resources, queried through GAQL rather than Postgres.
    "campaign", "customer", "keyword_view", "search_term_view", "click_view",
    "campaign_budget", "ad_group", "ad_group_ad", "conversion_action",
}


def known_relations() -> set[str]:
    sql = "".join(p.read_text() for p in pathlib.Path("migrations").glob("*.sql"))
    found = set()
    for pattern in (
        r'create table (?:if not exists )?"?([a-z_][a-z0-9_]*)',
        r'create (?:or replace )?(?:materialized )?view (?:if not exists )?"?([a-z_][a-z0-9_]*)',
        # A table only ever altered still exists - it was created elsewhere.
        r'alter table (?:if exists )?"?([a-z_][a-z0-9_]*)',
    ):
        found |= {m.lower() for m in re.findall(pattern, sql, re.I)}
    return found


def scan() -> list[dict]:
    real = known_relations()
    problems = []
    for f in sorted(pathlib.Path("src").rglob("*.ts")):
        if "__tests__" in str(f):
            continue
        text = f.read_text()
        # CTE names are defined locally and are not tables.
        ctes = {m.lower() for m in re.findall(r'(?:with|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(', text, re.I)}
        for m in re.finditer(r'\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]{3,})\b', text):
            name = m.group(1).lower()
            if name in real or name in ctes or name in NOT_TABLES or name.startswith("pg_"):
                continue
            problems.append({
                "file": str(f),
                "line": text[: m.start()].count("\n") + 1,
                "table": name,
            })
    return problems


def main() -> int:
    problems = scan()

    if "--write-baseline" in sys.argv:
        BASELINE.write_text(json.dumps(
            {"known": sorted({f"{p['file']}|{p['table']}" for p in problems})}, indent=1) + "\n")
        print(f"baseline written: {len(problems)} entries")
        return 0

    known = set(json.loads(BASELINE.read_text())["known"]) if BASELINE.exists() else set()
    new = [p for p in problems if f"{p['file']}|{p['table']}" not in known]

    if new:
        print("Queries naming a table the migrations never create:\n")
        for p in new:
            print(f"  {p['file']}:{p['line']}  ->  {p['table']}")
        print(
            "\nThis query cannot succeed. If it is wrapped in a .catch it will look\n"
            "like an empty result forever. Fix the name, add the migration, or - if\n"
            "it is not a Postgres table - add it to NOT_TABLES in this script."
        )
        return 1

    stale = known - {f"{p['file']}|{p['table']}" for p in problems}
    print(f"no new missing-table references ({len(known) - len(stale)} baselined"
          + (f", {len(stale)} since fixed - rerun with --write-baseline)" if stale else ")"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
