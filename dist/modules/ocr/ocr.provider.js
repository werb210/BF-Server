"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOpenAiOcrProvider = createOpenAiOcrProvider;
const config_1 = require("../../config");
const logger_1 = require("../../observability/logger");
function extractOutputText(payload) {
    if (typeof payload.output_text === "string") {
        return payload.output_text;
    }
    const output = payload.output;
    if (!Array.isArray(output)) {
        return "";
    }
    const chunks = [];
    for (const item of output) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const content = item.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const entry of content) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const type = entry.type;
            const text = entry.text;
            if (type === "output_text" && typeof text === "string") {
                chunks.push(text);
            }
        }
    }
    return chunks.join("\n").trim();
}
function parseStructuredJson(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
function createOpenAiOcrProvider() {
    return {
        async extract(params) {
            const apiKey = config_1.config.openai.apiKey;
            if (!apiKey) {
                (0, logger_1.logWarn)("openai_api_key_missing", { code: "openai_api_key_missing" });
                throw new Error("missing_openai_api_key");
            }
            const model = config_1.config.openai.ocrModel;
            const timeoutMs = config_1.config.ocr.timeoutMs;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const base64 = params.buffer.toString("base64");
                const content = [
                    {
                        type: "input_text",
                        text: "Extract all readable text from this document. Return plain text only.",
                    },
                ];
                if (params.mimeType === "application/pdf") {
                    content.push({
                        type: "input_file",
                        filename: params.fileName ?? "document.pdf",
                        file_data: base64,
                    });
                }
                else if (params.mimeType.startsWith("image/")) {
                    content.push({
                        type: "input_image",
                        image_url: `data:${params.mimeType};base64,${base64}`,
                    });
                }
                else {
                    throw new Error("unsupported_mime_type");
                }
                const response = await fetch("https://api.openai.com/v1/responses", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model,
                        input: [
                            {
                                role: "user",
                                content,
                            },
                        ],
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const message = await response.text();
                    throw new Error(`openai_ocr_failed:${response.status}:${message}`);
                }
                const payload = (await response.json());
                const text = extractOutputText(payload);
                return {
                    text,
                    json: parseStructuredJson(text),
                    meta: { id: payload.id ?? null },
                    model,
                    provider: "openai",
                };
            }
            finally {
                clearTimeout(timeout);
            }
        },
    };
}
