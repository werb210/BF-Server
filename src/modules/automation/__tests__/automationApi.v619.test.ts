// BF_SERVER_BLOCK_v619 - automation API validation and trigger wiring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateSteps } from "../../../routes/automations.js";

describe("automation API", () => {
  it("validates steps", () => {
    expect(validateSteps([{ type: "wait", amount: 0 }])).toMatch(/wait needs an amount/);
    expect(validateSteps([{ type: "launch_rocket" }])).toMatch(/unknown type/);
    expect(validateSteps([{ type: "send_sms", body: " " }])).toMatch(/text needs a message/);
    expect(validateSteps([{ type: "check", check: "still_in_stage" }, { type: "create_task", title: "ok" }])).toBeNull();
  });
});

describe("trigger points", () => {
  const has = (f: string, s: string) => expect(readFileSync(f, "utf8")).toContain(s);
  it("fire from every phase-1 trigger", () => {
    has("src/routes/portal.ts", 'trigger: "document.rejected"');
    has("src/routes/documents.ts", 'trigger: "document.rejected"');
    has("src/routes/smsInboundWebhook.ts", 'trigger: "message.inbound"');
    has("src/routes/client/index.ts", 'trigger: "message.inbound"');
    has("src/routes/serviceBridge.ts", 'trigger: "message.inbound"');
    has("src/routes/communications.ts", 'trigger: "call.missed"');
    has("src/modules/website/contact.controller.ts", 'trigger: "contact.created"');
    has("src/routes/creditReadiness.ts", 'trigger: "contact.created"');
    has("src/modules/applications/applications.service.ts", 'trigger: "application.stage_changed"');
  });
});
