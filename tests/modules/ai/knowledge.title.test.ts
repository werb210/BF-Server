import { describe, it, expect, vi } from "vitest";
import { embedAndStore } from "../../../src/modules/ai/knowledge.service.js";

describe("embedAndStore", () => {
  it("includes a non-null title in the INSERT params", async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        return { rows: [] };
      }),
    };
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // BF_SERVER_BLOCK_v571 - the embedding may succeed (mocked OpenAI) or fail; the title is what matters.
      await embedAndStore(db, "Hello world", "text", "src-1", "My title").catch(() => undefined);
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    }
    const insert = calls.find(c => /insert\s+into\s+ai_knowledge/i.test(c.text));
    expect(insert).toBeDefined();
    // params: [id, title, source_type, source_id, content]
    expect(insert!.params[1]).toBe("My title");
  });

  it("derives a title when none is provided", async () => {
    const calls: Array<{ params: unknown[] }> = [];
    const db = {
      query: vi.fn(async (_text: string, params?: unknown[]) => {
        calls.push({ params: params ?? [] });
        return { rows: [] };
      }),
    };
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await embedAndStore(db, "First line\nrest of doc", "text").catch(() => undefined); // BF_SERVER_BLOCK_v571
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    }
    expect(calls[0]?.params[1]).toBe("First line");
  });
});
