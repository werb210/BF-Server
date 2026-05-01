// BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING
import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
} from "@azure-rest/ai-document-intelligence";
import { AzureKeyCredential } from "@azure/core-auth";
import type { OcrExtractionResult, OcrProvider } from "./ocr.provider.js";

let _client: ReturnType<typeof DocumentIntelligence> | null = null;

function getClient() {
  if (_client) return _client;
  const endpoint = process.env.AZURE_DOC_INTEL_ENDPOINT;
  const key = process.env.AZURE_DOC_INTEL_KEY;
  if (!endpoint || !key) {
    throw new Error("AZURE_DOC_INTEL_ENDPOINT / AZURE_DOC_INTEL_KEY not set");
  }
  _client = DocumentIntelligence(endpoint, new AzureKeyCredential(key));
  return _client;
}

export type DocIntelModel =
  | "prebuilt-read"
  | "prebuilt-layout"
  | "prebuilt-bankStatement.us";

export async function analyzeWithDocIntel(
  buffer: Buffer,
  modelId: DocIntelModel = "prebuilt-read",
): Promise<any> {
  const client = getClient();
  const initial = await client
    .path("/documentModels/{modelId}:analyze", modelId)
    .post({ contentType: "application/octet-stream", body: buffer });
  if (isUnexpected(initial)) {
    throw new Error(
      `Doc Intel ${initial.status}: ${(initial.body as any)?.error?.message ?? "unknown error"}`,
    );
  }
  const poller = getLongRunningPoller(client, initial);
  const final = (await poller.pollUntilDone()).body as any;
  return final?.analyzeResult ?? {};
}

export function createAzureDocIntelOcrProvider(): OcrProvider {
  return {
    async extract({ buffer }) {
      const result = await analyzeWithDocIntel(buffer, "prebuilt-read");
      const text: string =
        typeof result.content === "string" && result.content.trim()
          ? result.content
          : (Array.isArray(result.paragraphs)
              ? result.paragraphs.map((p: any) => p?.content ?? "").filter(Boolean).join("\n")
              : "") || "";
      const out: OcrExtractionResult = {
        text,
        json: result,
        meta: { model: "prebuilt-read", apiVersion: result.apiVersion ?? null },
        model: "prebuilt-read",
        provider: "azure-doc-intel",
      };
      return out;
    },
  };
}
