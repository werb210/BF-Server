import { v4 as uuid } from "uuid";
const leads = [];
const MAX_LEADS = 500;
function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_LEADS)
        arr.shift();
}
export const createLead = (req, res) => {
    const body = req.body;
    if (!body.companyName || !body.fullName || !body.email) {
        return res.status(400).json({ message: "Missing required fields" });
    }
    const newLead = {
        id: uuid(),
        createdAt: new Date(),
        ...body,
    };
    pushBounded(leads, newLead);
    return res.status(201).json({
        success: true,
        leadId: newLead.id,
    });
};
export const fetchLeads = (_req, res) => {
    return res["json"](leads.slice(0, 100));
};
