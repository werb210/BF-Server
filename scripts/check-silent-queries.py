#!/usr/bin/env python3
"""BF_SERVER_SILENT_QUERY_GUARDRAIL_v215 (per-occurrence since v789)

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

BF_SERVER_v789_SILENT_QUERIES - what is caught:
  1. any query helper (pool.query, client.query, runQuery, dbQuery, safeQuery,
     anything named *query / *Query) whose call is followed directly by
     .catch(handler) where the handler neither logs nor rethrows;
  2. an empty catch block (`catch {}` / `catch (e) {}`) whose try block awaits a
     query helper.

The baseline is per occurrence: file plus the normalised text of the line the
call starts on, with a count. Unrelated edits elsewhere in a file do not churn it,
and a second copy of a baselined line in the same file is still new. Shrink the
baseline when you touch a file; never grow it.
"""
import hashlib
import json
import pathlib
import re
import sys
from collections import Counter

def _arg(name: str, default: str) -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


ROOT = pathlib.Path(_arg("--root", "src"))
BASELINE = pathlib.Path(_arg("--baseline", "scripts/silent-queries-baseline.json"))

QUERY_CALL = re.compile(r'(?<![\w$])(?:[\w$]+\s*\.\s*)*([\w$]*[qQ]uery)\s*(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>)?\s*\(')
CATCH_AFTER = re.compile(r'\s*\.catch\s*\(')
THEN_AFTER = re.compile(r'\s*\.(?:then|finally)\s*\(')
EMPTY_CATCH = re.compile(r'\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*[\w$]+)?\s*\))?\s*\{\s*\}')
TRY_OPEN = re.compile(r'\btry\s*\{')
AWAITED_QUERY = re.compile(r'\bawait\s+(?:[\w$]+\s*\.\s*)*[\w$]*[qQ]uery\s*(?:<[^()]*>)?\s*\(')
LOGGING = re.compile(r'log(Error|Warn|Info|WarnSwallowed|Swallowed)?\s*\(|log(Error|Warn|Info)|logger\.|console\.(error|warn|log)|captureException|\bthrow\b')
# Not database helpers even though they end in "query".
NOT_DB = {"useQuery", "parseQuery", "buildQuery", "querystring", "toQuery", "encodeQuery", "searchQuery"}


def skip_string(text: str, i: int) -> int:
    q = text[i]
    i += 1
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if q == "`" and c == "$" and i + 1 < len(text) and text[i + 1] == "{":
            i = match_close(text, i + 1, "{", "}") + 1
            continue
        if c == q:
            return i + 1
        i += 1
    return i


def match_close(text: str, open_idx: int, open_ch: str, close_ch: str) -> int:
    """Index of the bracket closing text[open_idx]; len(text) if unbalanced."""
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        c = text[i]
        if c in "'\"`":
            i = skip_string(text, i)
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            nl = text.find("\n", i)
            i = n if nl < 0 else nl
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return n


def norm(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip())


def key_for(path: str, line_text: str) -> str:
    return hashlib.sha1(f"{path}|{norm(line_text)}".encode()).hexdigest()[:16]


def swallow_ok(lines: list[str], line_no: int) -> bool:
    context = lines[max(0, line_no - 2):line_no + 1]
    return any("swallow-ok" in c for c in context)


def scan_file(f: pathlib.Path) -> list[dict]:
    text = f.read_text()
    lines = text.split("\n")
    found = []

    # 1. query(...).catch(handler without logging)
    for m in QUERY_CALL.finditer(text):
        name = m.group(1)
        if name in NOT_DB:
            continue
        open_idx = m.end() - 1
        close_idx = match_close(text, open_idx, "(", ")")
        if close_idx >= len(text):
            continue
        # allow .then(...) / .finally(...) links between the call and .catch
        pos = close_idx + 1
        while True:
            lm = THEN_AFTER.match(text, pos)
            if not lm:
                break
            pos = match_close(text, lm.end() - 1, "(", ")") + 1
        cm = CATCH_AFTER.match(text, pos)
        if not cm:
            continue
        c_open = cm.end() - 1
        c_close = match_close(text, c_open, "(", ")")
        handler = text[c_open + 1:c_close]
        if LOGGING.search(handler):
            continue
        line_no = text[: m.start()].count("\n") + 1
        if swallow_ok(lines, line_no):
            continue
        found.append({"file": str(f), "line": line_no, "kind": "catch", "text": lines[line_no - 1]})

    # 2. empty catch around an awaited query
    tries = [t.end() - 1 for t in TRY_OPEN.finditer(text)]
    for m in EMPTY_CATCH.finditer(text):
        # nearest try whose block closes right before this catch
        body = None
        for t_open in reversed(tries):
            if t_open >= m.start():
                continue
            t_close = match_close(text, t_open, "{", "}")
            if text[t_close + 1:m.start()].strip() == "":
                body = text[t_open:t_close]
                break
        if body is None or not AWAITED_QUERY.search(body):
            continue
        line_no = text[: m.start()].count("\n") + 1
        if swallow_ok(lines, line_no):
            continue
        found.append({"file": str(f), "line": line_no, "kind": "empty-catch", "text": lines[line_no - 1]})
    return found


def scan() -> list[dict]:
    found = []
    for f in sorted(ROOT.rglob("*.ts")):
        s = str(f)
        if "__tests__" in s or s.endswith(".test.ts") or s.endswith(".d.ts"):
            continue
        rel = f.relative_to(ROOT.parent).as_posix()
        for h in scan_file(f):
            h["file"] = rel
            h["key"] = key_for(rel, h["text"])
            found.append(h)
    return found


def main() -> int:
    found = scan()
    counts = Counter(h["key"] for h in found)

    if "--write-baseline" in sys.argv:
        entries = {}
        for h in found:
            entries.setdefault(h["key"], {"file": h["file"], "line": norm(h["text"])[:160], "count": 0})
            entries[h["key"]]["count"] += 1
        BASELINE.write_text(json.dumps(
            {"_comment": "Per-occurrence baseline written by scripts/check-silent-queries.py --write-baseline. Shrink only.",
             "total": sum(counts.values()),
             "entries": dict(sorted(entries.items()))}, indent=1) + "\n")
        print(f"baseline written: {sum(counts.values())} occurrences")
        return 0

    data = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    known = {k: int(v.get("count", 1)) for k, v in (data.get("entries") or {}).items()}

    new = []
    seen = Counter()
    for h in found:
        seen[h["key"]] += 1
        if seen[h["key"]] > known.get(h["key"], 0):
            new.append(h)

    if new:
        print("New silently-swallowed database queries:\n")
        for h in new:
            print(f"  {h['file']}:{h['line']}  [{h['kind']}]  {norm(h['text'])[:120]}")
        print(
            "\nA failed query here is indistinguishable from an empty result, so a\n"
            "typo in a table or column name becomes a feature that silently shows\n"
            "nothing. Either log the error in the handler:\n\n"
            "    .catch((err) => { logError(\"thing_failed\", { message: err?.message }); return { rows: [] }; })\n\n"
            "or mark the line `swallow-ok` with the reason it is safe."
        )
        return 1

    total_known = sum(known.values())
    total_found = sum(counts.values())
    stale = total_known - total_found
    print(f"no new silent queries ({total_found} baselined occurrences"
          + (f", {stale} since fixed - rerun with --write-baseline to shrink)" if stale > 0 else ")"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
