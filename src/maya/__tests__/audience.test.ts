// AGENT_BLOCK_v2_AUDIENCE_AND_STAFF_PIPELINE_TOOL_v1
import { describe, it, expect } from "vitest";
import {
  parseAudience,
  isToolAllowed,
  TOOLS_BY_AUDIENCE,
  MAYA_AUDIENCE_HEADER,
} from "../audience.js";

describe("AGENT_BLOCK_v2 — audience contract", () => {
  it("parseAudience accepts the three valid values", () => {
    expect(parseAudience("visitor")).toBe("visitor");
    expect(parseAudience("client")).toBe("client");
    expect(parseAudience("staff")).toBe("staff");
  });

  it("parseAudience falls back to 'visitor' on unknown or bad input", () => {
    expect(parseAudience(undefined)).toBe("visitor");
    expect(parseAudience("")).toBe("visitor");
    expect(parseAudience(123)).toBe("visitor");
    expect(parseAudience("admin")).toBe("visitor");
  });

  it("parseAudience honors caller-supplied fallback", () => {
    expect(parseAudience(undefined, "client")).toBe("client");
  });

  it("header constant matches the public contract", () => {
    expect(MAYA_AUDIENCE_HEADER).toBe("x-maya-audience");
  });

  it("visitor cannot call staff tools", () => {
    expect(isToolAllowed("visitor", "pipeline.query")).toBe(false);
    expect(isToolAllowed("visitor", "comm.send_sms")).toBe(false);
  });

  it("client cannot call staff tools", () => {
    expect(isToolAllowed("client", "pipeline.query")).toBe(false);
    expect(isToolAllowed("client", "call.initiate")).toBe(false);
  });

  it("staff cannot call visitor 'lead.capture' (different surface)", () => {
    expect(isToolAllowed("staff", "lead.capture")).toBe(false);
  });

  it("staff can call pipeline.query and contact.find", () => {
    expect(isToolAllowed("staff", "pipeline.query")).toBe(true);
    expect(isToolAllowed("staff", "contact.find")).toBe(true);
  });

  it("client can call pgi.completion_link", () => {
    expect(isToolAllowed("client", "pgi.completion_link")).toBe(true);
  });

  it("every whitelist entry is non-empty", () => {
    expect(TOOLS_BY_AUDIENCE.visitor.length).toBeGreaterThan(0);
    expect(TOOLS_BY_AUDIENCE.client.length).toBeGreaterThan(0);
    expect(TOOLS_BY_AUDIENCE.staff.length).toBeGreaterThan(0);
  });
});
