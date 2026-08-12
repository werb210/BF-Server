// BF_SERVER_ONE_POOL_v45
// Source assertions because importing these modules needs a live database.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.includes("dbTestUtils")) {
      out.push(full);
    }
  }
  return out;
}

describe("connection pools", () => {
  it("constructs exactly one pg Pool across the server", () => {
    const offenders = walk("src").filter((f) => /new Pool\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual(["src/db.prod.ts"]);
  });

  it("keeps the configured pool the one the runQuery path uses", () => {
    const init = readFileSync("src/db/init.ts", "utf8");
    expect(init).toContain("db.prod.js");
    expect(init).not.toContain("new Pool(");
  });

  it("routes the platform and lib helpers at the same pool", () => {
    expect(readFileSync("src/platform/dbClient.ts", "utf8")).toContain("db.prod.js");
    expect(readFileSync("src/lib/db.ts", "utf8")).toContain("db.prod.js");
  });
});
