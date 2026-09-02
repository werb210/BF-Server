import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const s = readFileSync(
  path.join(process.cwd(), "src/routes/reception.ts"),
  "utf8",
);

describe("reception routing precedence", () => {
  it("prefers the Boreal client and permits only gated standalone Watch cellular fallback", () => {
    expect(s).toContain("if (t.clientReady && t.identity)");
    expect(s).toContain("dial.client(t.identity);");

    expect(s).toContain("if (t.standaloneWatch && t.cell)");
    expect(s).toContain("dial.number(t.cell);");

    expect(s).toContain("verified_callback_number");
    expect(s).toContain("callback_verified_at IS NOT NULL");
    expect(s).toContain("standalone_routing_enabled=true");

    const clientBranch = s.indexOf("if (t.clientReady && t.identity)");
    const clientDial = s.indexOf("dial.client(t.identity);", clientBranch);
    const clientReturn = s.indexOf("return send(res, v);", clientDial);
    const watchBranch = s.indexOf("if (t.standaloneWatch && t.cell)");

    expect(clientBranch).toBeGreaterThanOrEqual(0);
    expect(clientDial).toBeGreaterThan(clientBranch);
    expect(clientReturn).toBeGreaterThan(clientDial);
    expect(watchBranch).toBeGreaterThan(clientReturn);
  });
});
