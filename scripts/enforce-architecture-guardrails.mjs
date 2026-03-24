import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/routes";
const BASELINE_ALLOWLIST = new Set([
  "src/routes/ai.ts",
  "src/routes/ai.v2.ts",
  "src/routes/application.ts",
  "src/routes/client/lenders.ts",
  "src/routes/client/v1Applications.ts",
  "src/routes/continuation.ts",
  "src/routes/creditReadiness.ts",
  "src/routes/debugDbTest.ts",
  "src/routes/liveChat.ts",
  "src/routes/messages.ts",
  "src/routes/offers.ts",
  "src/routes/portal.ts",
  "src/routes/products.ts",
  "src/routes/pwa.ts",
  "src/routes/systemCheck.ts",
  "src/routes/twilio.ts",
]);

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }

    if (!full.endsWith(".ts")) continue;

    const content = readFileSync(full, "utf8");
    const hasDirectDbCall = content.includes("pool.query(") || content.includes("db.query(");
    if (hasDirectDbCall && !BASELINE_ALLOWLIST.has(full)) {
      violations.push(`${full}: new direct DB call in route file (move data access into /modules)`);
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error("Architecture guardrail violations found:\n");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Architecture guardrails passed.");
