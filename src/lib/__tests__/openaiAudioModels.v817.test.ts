// BF_SERVER_v817_AUDIO_MODELS
import { describe, expect, it, vi } from "vitest";
import { ttsModel, transcribeModel, withAudioModelFallback } from "../openaiAudioModels.js";

describe("v817 OpenAI audio models", () => {
  it("default to the replacements and honour the settings", () => {
    expect(ttsModel({} as any)).toBe("gpt-4o-mini-tts");
    expect(transcribeModel({} as any)).toBe("gpt-4o-mini-transcribe");
    expect(ttsModel({ OPENAI_TTS_MODEL: "tts-1-hd" } as any)).toBe("tts-1-hd");
    expect(transcribeModel({ OPENAI_TRANSCRIBE_MODEL: " whisper-1 " } as any)).toBe("whisper-1");
  });

  it("falls back once to the legacy model", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const call = vi.fn(async (m: string) => { if (m === "new") throw new Error("not enabled"); return m; });
    await expect(withAudioModelFallback("new", "old", call, "t")).resolves.toBe("old");
    expect(call).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does not retry when the configured model is the legacy one", async () => {
    const call = vi.fn(async () => { throw new Error("down"); });
    await expect(withAudioModelFallback("tts-1", "tts-1", call, "t")).rejects.toThrow("down");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
