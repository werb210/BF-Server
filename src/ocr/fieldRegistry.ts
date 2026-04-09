import { fetchOcrFieldRegistry, type OcrFieldDefinition } from "./ocrFieldRegistry.js";

export type { OcrFieldDefinition };

export function fetchOcrFieldDefinitions(): OcrFieldDefinition[] {
  return fetchOcrFieldRegistry();
}

export function fetchOcrFieldsForDocumentType(): OcrFieldDefinition[] {
  return fetchOcrFieldRegistry();
}
