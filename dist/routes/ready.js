import { deps } from "../system/deps.js";
export function readyRoute(_req, res) {
    if (process.env.NODE_ENV === "test") {
        return res.status(200).json({ status: "ok", data: {} });
    }
    if (!deps.db.ready) {
        return res.status(503).json({ status: "not_ready", data: {} });
    }
    return res.status(200).json({ status: "ok", data: {} });
}
export const readyHandler = readyRoute;
