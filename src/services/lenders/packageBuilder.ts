export function buildLenderPackage(data: {
  application: unknown;
  documents: unknown;
  creditSummary: unknown;
}) {
  const {
    application,
    documents,
    creditSummary,
  } = data;

  return {
    application,
    creditSummary,
    documents,
  };
}
