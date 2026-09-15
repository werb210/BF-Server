import { config } from "../../config/index.js";
import { logWarn } from "../../observability/logger.js";
import { withRetry } from "../../lib/retry.js";
import { extractPdfInChunks, isRetryableOcrError } from "./pdfChunking.js"; // BF_SERVER_OCR_LARGE_PDF_v260
import { pushDeadLetter } from "../../lib/deadLetter.js";
import {
  fetchOcrFieldRegistry,
  type OcrFieldDefinition,
} from "./ocrFieldRegistry.js";

export type OcrExtractionResult = {
  text: string;
  json: unknown | null;
  meta: unknown | null;
  model: string;
  provider: string;
};

export type OcrProvider = {
  extract: (params: { buffer: Buffer; mimeType: string; fileName?: string }) => Promise<OcrExtractionResult>;
};

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  const output = payload.output;
  if (!Array.isArray(output)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const type = (entry as { type?: string }).type;
      const text = (entry as { text?: string }).text;
      if (type === "output_text" && typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  return chunks.join("\n").trim();
}

// BF_SERVER_BLOCK_v196_OCR_PROMPT_AND_JSON_SCHEMA_v1
function buildFieldSchema(registry: OcrFieldDefinition[]): string {
  const compact = registry.map((f) => {
    const entry: Record<string, unknown> = { k: f.field_key, l: f.display_label };
    if (f.aliases && f.aliases.length > 0) entry.a = f.aliases;
    return entry;
  });
  return JSON.stringify(compact);
}

// BF_SERVER_BLOCK_v196_OCR_PROMPT_AND_JSON_SCHEMA_v1
function buildExtractionPrompt(schemaJson: string): string {
  return [
    "You are extracting structured data from a financial or business document",
    "(balance sheet, income statement, cash flow, tax return, contract, invoice,",
    "or loan application).",
    "",
    "Return a SINGLE JSON object with this exact shape and NOTHING ELSE:",
    '{"raw_text":"<all readable text, line breaks preserved>","fields":{"<field_key>":"<value>"}}',
    "",
    "Rules:",
    "- Use the field_key (snake_case) as the JSON property name. NEVER use display_label.",
    "- Include ONLY fields you confidently identify in the document. Omit absent fields entirely. Do NOT return null, empty string, or 'N/A'.",
    "- Return values exactly as they appear (currency symbols, parentheses for negatives, dates as printed). Do NOT normalize, convert, or reformat.",
    "- raw_text MUST contain the full readable text of the document for downstream search.",
    "- If a field appears multiple times (e.g. across years), return the most recent.",
    "",
    "Schema (k=field_key, l=display_label, a=optional aliases the label may also appear as):",
    schemaJson,
  ].join("\n");
}

function parseModelJsonOutput(rawOutput: string): {
  rawText: string | null;
  fields: Record<string, string> | null;
} {
  const stripped = rawOutput
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { rawText: null, fields: null };
  }
  const candidate = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const rawText = typeof parsed.raw_text === "string" ? parsed.raw_text : null;
    const fieldsRaw = parsed.fields;
    let fields: Record<string, string> | null = null;
    if (fieldsRaw && typeof fieldsRaw === "object" && !Array.isArray(fieldsRaw)) {
      fields = {};
      for (const [k, v] of Object.entries(fieldsRaw as Record<string, unknown>)) {
        if (typeof k !== "string") continue;
        if (typeof v === "string") {
          const trimmedV = v.trim();
          if (trimmedV) fields[k] = trimmedV;
        } else if (typeof v === "number") {
          fields[k] = String(v);
        }
      }
    }
    return { rawText, fields };
  } catch {
    return { rawText: null, fields: null };
  }
}

export function createOpenAiOcrProvider(): OcrProvider {
  return {
    async extract(params) {
      const apiKey = config.openai.apiKey;
      if (!apiKey) {
        logWarn("openai_api_key_missing", { code: "openai_api_key_missing" });
        throw new Error("missing_openai_api_key");
      }
      const model = config.openai.ocrModel;
      const timeoutMs = config.ocr.timeoutMs;
      const registry = fetchOcrFieldRegistry();
      const schemaJson = buildFieldSchema(registry);
      const promptText = buildExtractionPrompt(schemaJson);

      // One model request. BF_SERVER_OCR_LARGE_PDF_v260 - each request gets its own
      // timeout, and permanent 4xx errors (e.g. context_length_exceeded) are not retried.
      const requestOnce = async (buffer: Buffer, mimeType: string, fileName: string | undefined) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const base64 = buffer.toString("base64");
          const content: Array<Record<string, unknown>> = [
            { type: "input_text", text: promptText },
          ];
          if (mimeType === "application/pdf") {
            content.push({
              type: "input_file",
              filename: fileName ?? "document.pdf",
              file_data: `data:${mimeType};base64,${base64}`,
            });
          } else if (mimeType.startsWith("image/")) {
            content.push({
              type: "input_image",
              image_url: `data:${mimeType};base64,${base64}`,
            });
          } else {
            throw new Error("unsupported_mime_type");
          }
          const requestBody = { model, input: [{ role: "user", content }] };
          const payload = await withRetry(async () => {
            const response = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });
            if (!response.ok) {
              const message = await response.text();
              throw new Error(`openai_ocr_failed:${response.status}:${message}`);
            }
            return (await response.json()) as Record<string, unknown>;
          }, { shouldRetry: isRetryableOcrError });
          const rawOutput = extractOutputText(payload);
          const { rawText, fields } = parseModelJsonOutput(rawOutput);
          return {
            text: rawText ?? rawOutput,
            fields: (fields ?? null) as Record<string, unknown> | null,
            meta: { id: payload.id ?? null, json_parse_succeeded: rawText !== null || fields !== null },
          };
        } finally {
          clearTimeout(timeout);
        }
      };

      try {
        if (params.mimeType === "application/pdf") {
          const result = await extractPdfInChunks(params.buffer, (pdf) => requestOnce(pdf, params.mimeType, params.fileName));
          return {
            text: result.text,
            json: { fields: result.fields },
            meta: {
              model_extracted_field_count: Object.keys(result.fields).length,
              pdf_pages: result.pages,
              ocr_requests: result.chunks,
            },
            model,
            provider: "openai",
          };
        }
        const single = await requestOnce(params.buffer, params.mimeType, params.fileName);
        return {
          text: single.text,
          json: { fields: single.fields ?? {} },
          meta: { ...single.meta, model_extracted_field_count: single.fields ? Object.keys(single.fields).length : 0 },
          model,
          provider: "openai",
        };
      } catch (error) {
        await pushDeadLetter({
          type: "ocr_openai",
          data: {
            mimeType: params.mimeType,
            fileName: params.fileName ?? null,
            sizeBytes: params.buffer.length,
          },
          error: String(error),
        });
        throw error;
      }
    },
  };
}

export { createAzureDocIntelOcrProvider } from "./azureDocIntelProvider.js";
