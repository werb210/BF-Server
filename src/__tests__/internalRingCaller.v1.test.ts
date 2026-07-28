// BF_SERVER_INTERNAL_RING_CALLER_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readSource = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("internal incoming-ring caller resolution", () => {
  it("resolves an internal caller from the live conference", () => {
    const source = readSource("../routes/voiceCalls.ts");
    const route = source.slice(
      source.indexOf('router.post("/resolve-caller"'),
      source.indexOf("// BF_SERVER_RECENT_CALLS_v1"),
    );

    expect(route).toContain("conferenceFriendly");
    expect(route).toContain("FROM conferences c");
    expect(route).toContain("JOIN conference_participants cp");
    expect(route).toContain("cp.identity = c.created_by_user_id::text");
    expect(route).toContain("c.direction = 'internal'");
  });

  it("keeps contact and staff phone lookups in independent error boundaries", () => {
    const source = readSource("../routes/voiceCalls.ts");
    expect(source).toContain("resolve_caller_contact_failed");
    expect(source).toContain("resolve_caller_staff_failed");
  });

  it("broadcasts by conference id and sends the joinable friendly name", () => {
    const webhooks = readSource("../routes/webhooks.ts");
    const service = readSource("../voice/conferenceService.ts");

    expect(webhooks).toContain('broadcastIncomingRing(conf.id, "Client mini-portal")');
    expect(webhooks).toContain("broadcastIncomingRing(conf.id, from)");
    expect(webhooks).not.toContain("broadcastIncomingRing(staffIds");
    expect(service).toContain("confRow?.friendly_name || conferenceId");
    expect(service).toContain("conferenceFriendly: friendly");
  });
});
