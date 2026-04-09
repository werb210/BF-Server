const versions = [];
const MAX_VERSIONS = 500;
export function addVersion(version) {
    versions.push(version);
    if (versions.length > MAX_VERSIONS) {
        versions.shift();
    }
}
export function fetchVersions(documentId) {
    return versions.filter((version) => version.documentId === documentId).slice(-100);
}
