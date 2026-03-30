"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sheetMap = void 0;
exports.sheetMap = {
    applicationIdHeader: "Application ID",
    columns: [
        {
            header: "Application ID",
            value: (payload) => payload.application.id,
        },
    ],
};
