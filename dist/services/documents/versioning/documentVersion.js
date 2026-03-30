"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addVersion = addVersion;
exports.fetchVersions = fetchVersions;
const versions = [];
const MAX_VERSIONS = 500;
function addVersion(version) {
    versions.push(version);
    if (versions.length > MAX_VERSIONS) {
        versions.shift();
    }
}
function fetchVersions(documentId) {
    return versions.filter((version) => version.documentId === documentId).slice(-100);
}
