export const send = {
    ok: (res, data = { ok: true }) => res["json"](data),
    error: (res, status, msg) => res.status(status).json({ error: msg }),
};
