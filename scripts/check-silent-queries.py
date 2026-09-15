#!/usr/bin/env python3
"""BF_SERVER_SILENT_QUERY_GUARDRAIL_v215

Fails CI when a new database query has its failure swallowed into a value.

Four features died silently this way and nobody noticed for months:

  * watch presence read table user_presence, which does not exist  -> always "away"
  * watch missed calls read call_logs.user_id, which does not exist -> always 0
  * watch tasks due read crm_tasks, which is retired                -> always 0
  * the disposition follow-up violated a CHECK on tasks.source      -> never inserted

Every one was `.catch(() => <default>)`. A wrong column name is indistinguishable
from an empty result, so the feature reports "nothing to show" forever.

This does NOT ban the pattern - degrading rather than throwing is often right on a
dashboard or a watch face. It bans doing it *silently*. Log the error, or mark the
line `swallow-ok` with a reason.

There are already 237 of these. Failing all of them would block every merge, so
the existing set is baselined in scripts/silent-queries-baseline.json and only
NEW ones fail. Shrink the baseline when you touch a file; never grow it.
"""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path("src")
BASELINE = pathlib.Path("scripts/silent-queries-baseline.json")

QUERY_CATCH = re.compile(
    r'\.query\s*[<(][\s\S]{0,1500}?\)\s*\.catch\(\s*\([^)]*\)\s*=>\s*([^;\n]*)'
)
LOGGING = re.compile(r'log(Error|Warn|Info)|console\.(error|warn)|captureException')


def fingerprint(path: str, table: str | None) -> str:
    # Keyed on file and table rather than line number, so unrelated edits above a
    # handler do not churn the baseline.
    return hashlib.sha1(f"{path}|{table or '?'}".encode()).hexdigest()[:12]


def scan() -> list[dict]:
    found = []
    for f in sorted(ROOT.rglob("*.ts")):
        if "__tests__" in str(f):
            continue
        text = f.read_text()
        lines = text.split("\n")
        for m in QUERY_CATCH.finditer(text):
            if LOGGING.search(m.group(1)):
                continue
            line_no = text[: m.start()].count("\n") + 1
            context = lines[max(0, line_no - 2):line_no]
            if any("swallow-ok" in c for c in context):
                continue
            seg = text[m.start():m.end()]
            tbl = re.search(r'\b(?:FROM|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)', seg, re.I)
            table = tbl.group(1).lower() if tbl else None
            found.append({
                "file": str(f),
                "line": line_no,
                "table": table,
                "key": fingerprint(str(f), table),
            })
    return found


def main() -> int:
    found = scan()

    if "--write-baseline" in sys.argv:
        BASELINE.write_text(json.dumps(
            {"keys": sorted({h["key"] for h in found})}, indent=1) + "\n")
        print(f"baseline written: {len(set(h['key'] for h in found))} entries")
        return 0

    known = set(json.loads(BASELINE.read_text())["keys"]) if BASELINE.exists() else set()
    new = [h for h in found if h["key"] not in known]

    if new:
        print("New silently-swallowed database queries:\n")
        for h in new:
            where = f"{h['file']}:{h['line']}"
            print(f"  {where}" + (f"  (table: {h['table']})" if h["table"] else ""))
        print(
            "\nA failed query here is indistinguishable from an empty result, so a\n"
            "typo in a table or column name becomes a feature that silently shows\n"
            "nothing. Either log the error in the handler:\n\n"
            "    .catch((err) => { logError(\"thing_failed\", { message: err?.message }); return { rows: [] }; })\n\n"
            "or mark the line `swallow-ok` with the reason it is safe."
        )
        return 1

    stale = known - {h["key"] for h in found}
    print(f"no new silent queries ({len(known) - len(stale)} baselined"
          + (f", {len(stale)} since fixed - rerun with --write-baseline to shrink)" if stale else ")"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
