import { fetchOcrFieldRegistry, type OcrFieldDefinition } from "./ocrFieldRegistry";

export type { OcrFieldDefinition };

export function fetchOcrFieldDefinitions(): OcrFieldDefinition[] {
  return fetchOcrFieldRegistry();
}

export function fetchOcrFieldsForDocumentType(): OcrFieldDefinition[] {
  return fetchOcrFieldRegistry();
}
