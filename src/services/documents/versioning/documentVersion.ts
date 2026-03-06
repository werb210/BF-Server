export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  createdAt: number;
  hash: string;
  path: string;
}

const versions: DocumentVersion[] = [];

export function addVersion(version: DocumentVersion): void {
  versions.push(version);
}

export function getVersions(documentId: string): DocumentVersion[] {
  return versions.filter((version) => version.documentId === documentId);
}
