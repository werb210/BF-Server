"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPLICATIONS_PARTIAL_UNIQUE_INDEXES = void 0;
exports.APPLICATIONS_PARTIAL_UNIQUE_INDEXES = [
    {
        name: "applications_submission_key_unique",
        columns: ["submission_key"],
        where: "submission_key is not null",
    },
    {
        name: "applications_external_id_unique",
        columns: ["external_id"],
        where: "external_id is not null",
    },
    {
        name: "applications_client_submission_id_unique",
        columns: ["client_submission_id"],
        where: "client_submission_id is not null",
    },
];
