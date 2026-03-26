export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  createdAt: number;
  hash: string;
  path: string;
}

const versions: DocumentVersion[] = [];
const MAX_VERSIONS = 500;

export function addVersion(version: DocumentVersion): void {
  versions.push(version);
  if (versions.length > MAX_VERSIONS) {
    versions.shift();
  }
}

export function fetchVersions(documentId: string): DocumentVersion[] {
  return versions.filter((version) => version.documentId === documentId).slice(-100);
}
