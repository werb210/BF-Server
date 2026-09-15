#!/usr/bin/env python3
"""BF_SERVER_INTEGRATION_RATCHET_v221

Turns the integration suite from "green badge on a failing suite" into a ratchet.

The step carried `continue-on-error: true` with a note to flip it off once the
standing failures were burned down. The intent was right - 60 failures would block
every merge - but the effect was that GitHub showed the job green, so nobody saw
the number and it was free to grow. This run had 39 failing files and nobody knew.

So: the suite still does not block on its existing failures, but it DOES block if
the count gets worse, and the real numbers always land in the job summary.

Reads the vitest JSON report and compares against scripts/integration-ceiling.json.
"""
import json
import os
import pathlib
import sys

CEILING = pathlib.Path("scripts/integration-ceiling.json")


def summary(line: str) -> None:
    print(line)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def main() -> int:
    report_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/integration-report.json")
    if not report_path.exists():
        summary("### Integration suite produced no report")
        summary("The run crashed before writing JSON - that is a failure, not a pass.")
        return 1

    try:
        report = json.loads(report_path.read_text())
    except json.JSONDecodeError as err:
        summary(f"### Integration report was not valid JSON ({err})")
        return 1

    failed_files = int(report.get("numFailedTestSuites", 0))
    failed_tests = int(report.get("numFailedTests", 0))
    total_tests = int(report.get("numTotalTests", 0))

    # BF_SERVER_RATCHET_COLLECTION_v225
    # A file that throws while being imported reports as a failed suite with no
    # failed tests inside it - nothing ran. Those are a different problem from an
    # assertion failure (usually a missing table, env var or import), and they
    # are why the file count can be double the test count. Counting them
    # separately stops one hiding behind the other.
    collection_failures = [
        t for t in report.get("testResults", [])
        if t.get("status") == "failed"
        and not any(
            a.get("status") == "failed"
            for a in (t.get("assertionResults") or [])
        )
    ]
    n_collection = len(collection_failures)

    ceiling = json.loads(CEILING.read_text())
    max_files = int(ceiling["maxFailedFiles"])
    max_tests = int(ceiling["maxFailedTests"])
    max_collection = int(ceiling.get("maxCollectionFailures", max_files))

    summary("### Integration suite")
    summary("")
    summary(f"- Failing files: **{failed_files}** (ceiling {max_files})")
    summary(f"- Failing tests: **{failed_tests}** of {total_tests} (ceiling {max_tests})")
    summary(f"- Files that failed before running anything: **{n_collection}** (ceiling {max_collection})")
    summary("")
    if n_collection:
        summary(
            "Those files threw on import - a missing table, env var or module, "
            "not a broken assertion. They are usually one root cause each, "
            "fixing many tests at once."
        )
        summary("")
        summary("<details><summary>Import failures</summary>\n")
        for t in sorted(collection_failures, key=lambda x: x.get("name", "")):
            summary(f"- {t.get('name', '?').split('/')[-1]}")
        summary("\n</details>")
    summary("")

    names = sorted(
        t.get("name", "?").split("/")[-1]
        for t in report.get("testResults", [])
        if t.get("status") == "failed"
    )
    if names:
        summary("<details><summary>Failing files</summary>\n")
        for n in names:
            summary(f"- {n}")
        summary("\n</details>")

    if failed_files > max_files or failed_tests > max_tests or n_collection > max_collection:
        summary("")
        summary("**This change made the integration suite worse.**")
        summary(
            f"Files {failed_files} > {max_files}" if failed_files > max_files else ""
        )
        summary(
            f"Tests {failed_tests} > {max_tests}" if failed_tests > max_tests else ""
        )
        summary(
            f"Import failures {n_collection} > {max_collection}" if n_collection > max_collection else ""
        )
        return 1

    if failed_files < max_files or failed_tests < max_tests:
        summary("")
        summary(
            f"Improved. Lower the ceiling in scripts/integration-ceiling.json to "
            f"{failed_files} files / {failed_tests} tests / {n_collection} import "
            f"failures so it cannot regress."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
