// BF_SERVER_BLOCK_v476
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const client = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
const offers = readFileSync(fileURLToPath(new URL("../routes/offers.ts", import.meta.url)), "utf-8");

describe("v476 client offers + rejected documents", () => {
  it("mounts owner-guarded client routes", () => {
    expect(client).toMatch(/"\/offers",\s*\n\s*makeSigningOwnerGuard\(/);
    expect(client).toMatch(/"\/rejected-documents",\s*\n\s*makeSigningOwnerGuard\(/);
  });
  it("reuses the staff term-sheet URL helper", () => {
    expect(offers).toContain("export async function attachTermSheetUrls");
    expect(client).toContain('await import("../offers.js")');
  });
});
