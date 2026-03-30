"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRANSMISSIONS_PARTIAL_UNIQUE_INDEXES = void 0;
exports.TRANSMISSIONS_PARTIAL_UNIQUE_INDEXES = [
    {
        name: "transmissions_idempotency_key_route_uq",
        columns: ["idempotency_key", "route"],
    },
];
