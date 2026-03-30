"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCRMLead = createCRMLead;
const node_crypto_1 = require("node:crypto");
const crmWebhook_1 = require("./crmWebhook");
async function createCRMLead(lead) {
    const id = (0, node_crypto_1.randomUUID)();
    await (0, crmWebhook_1.pushLeadToCRM)({
        id,
        type: "lead",
        ...lead,
    });
    return { id };
}
