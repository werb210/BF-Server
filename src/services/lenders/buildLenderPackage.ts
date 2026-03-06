export interface LenderPackage {
  application: unknown;
  documents: unknown[];
  creditSummary: unknown;
}

export function buildLenderPackage(
  application: unknown,
  documents: unknown[],
  creditSummary: unknown
): LenderPackage {
  return {
    application,
    documents,
    creditSummary,
  };
}
