"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLeads = exports.createLead = void 0;
const uuid_1 = require("uuid");
const leads = [];
const MAX_LEADS = 500;
function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_LEADS)
        arr.shift();
}
const createLead = (req, res) => {
    const body = req.body;
    if (!body.companyName || !body.fullName || !body.email) {
        return res.status(400).json({ message: "Missing required fields" });
    }
    const newLead = {
        id: (0, uuid_1.v4)(),
        createdAt: new Date(),
        ...body,
    };
    pushBounded(leads, newLead);
    return res.status(201).json({
        success: true,
        leadId: newLead.id,
    });
};
exports.createLead = createLead;
const fetchLeads = (_req, res) => {
    return res["json"](leads.slice(0, 100));
};
exports.fetchLeads = fetchLeads;
