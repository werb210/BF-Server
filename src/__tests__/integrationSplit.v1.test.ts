// BF_SERVER_SPLIT_INTEGRATION_TESTS_v1
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { INTEGRATION_TEST_FILES } from "../../vitest.integration.js";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("integration test split", () => {
  it("every excluded path actually exists", () => {
    // A stale path here would exclude nothing and quietly re-admit a failing
    // file to the default run, which is how the suite went red unnoticed before.
    const missing = INTEGRATION_TEST_FILES.filter(
      (f) => !existsSync(path.join(process.cwd(), f)),
    );
    expect(missing).toEqual([]);
  });

  it("the exclusion is opt-out, not permanent", () => {
    expect(read("vitest.config.ts")).toContain('process.env.VITEST_INTEGRATION === "true"');
  });

  it("exposes a way to run the excluded tests on demand", () => {
    const pkg = read("package.json");
    expect(pkg).toContain("test:integration");
    expect(pkg).toContain("VITEST_INTEGRATION=true");
  });

  it("CI runs the unit suite instead of skipping it", () => {
    const wf = read(".github/workflows/ci.yml");
    expect(wf).toContain("npm run test:ci");
    // Match the RUN line, not the string anywhere in the file - the comment
    // above the step quotes the old command to explain what changed, and a bare
    // toContain check would fire on that comment.
    expect(wf).not.toContain('run: echo "Skipping tests"');
  });

  it("the test-mode database url is a real connection string", () => {
    const cfg = read("src/config/index.ts");
    expect(cfg).not.toContain('isTestMode ? "test" : ""');
    expect(cfg).toContain("postgres://test:test@127.0.0.1:5432/bf_test");
  });
});
