export const TRANSMISSIONS_PARTIAL_UNIQUE_INDEXES = [
    {
        name: "transmissions_idempotency_key_route_uq",
        columns: ["idempotency_key", "route"],
    },
];
