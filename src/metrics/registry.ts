import client from "prom-client";

client.collectDefaultMetrics();

export const registry = client.register;
