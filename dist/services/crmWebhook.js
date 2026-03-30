"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushLeadToCRM = pushLeadToCRM;
const config_1 = require("../config");
async function pushLeadToCRM(data) {
    if (!config_1.config.crm.webhookUrl) {
        return;
    }
    await fetch(config_1.config.crm.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
