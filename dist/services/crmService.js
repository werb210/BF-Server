import { randomUUID } from "node:crypto";
import { pushLeadToCRM } from "./crmWebhook.js";
export async function createCRMLead(lead) {
    const id = randomUUID();
    await pushLeadToCRM({
        id,
        type: "lead",
        ...lead,
    });
    return { id };
}
