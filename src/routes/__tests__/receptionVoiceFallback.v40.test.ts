// BF_SERVER_RECEPTION_VOICE_FALLBACK_v40
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { shouldPlayAudio, __receptionVoiceCacheForTests } from "../reception.js";

const src = readFileSync(path.join(process.cwd(), "src/routes/reception.ts"), "utf8");
const cache = __receptionVoiceCacheForTests();
const previous = process.env.RECEPTION_NOVA_VOICE;

beforeEach(() => { cache.clear(); });
afterEach(() => { process.env.RECEPTION_NOVA_VOICE = previous; });

describe("a cold cache can no longer point a live call at a 503", () => {
  it("does not play audio that has not been rendered", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    expect(shouldPlayAudio("greeting")).toBe(false);
  });

  it("plays it once it really is cached", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(true);
  });

  it("never plays when the nova voice is switched off", () => {
    process.env.RECEPTION_NOVA_VOICE = "false";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(false);
  });

  it("decides per line, so one failed render cannot mute the rest", () => {
    process.env.RECEPTION_NOVA_VOICE = "true";
    cache.set("greeting", Buffer.from("fake-mp3"));
    expect(shouldPlayAudio("greeting")).toBe(true);
    expect(shouldPlayAudio("intent_prompt")).toBe(false);
  });
});

describe("emit routes through that decision", () => {
  it("has no other path to Play", () => {
    const fn = src.slice(src.indexOf("function emit("), src.indexOf("function speech("));
    expect(fn).toContain("if (shouldPlayAudio(key)) node.play(");
    expect(fn).toContain("node.say({ voice: VOICE }, text)");
    expect((fn.match(/node\.play\(/g) || []).length).toBe(1);
  });
});

describe("a render failure is legible instead of silent", () => {
  it("says why rather than swallowing every cause alike", () => {
    expect(src).toContain("reception_voice_render_failed");
    expect(src).toContain('reason: "no_openai_api_key"');
    expect(src).not.toContain("} catch { return null; }");
  });

  it("reports how much of the greeting is degraded at boot", () => {
    expect(src).toContain("reception_voice_warm");
    expect(src).toContain("degradedToPolly");
  });
});

describe("the greeting itself is untouched", () => {
  it("keeps the keypad fallback and the handoff to the company step", () => {
    expect(src).toContain('input: "speech dtmf"');
    expect(src).toContain("press 1 for Financial, 2 for Risk Management");
    expect(src).toContain("`${BASE}/company`");
  });
});
