export const runtimeHandler = (req, res) => {
    res["json"]({
        status: "ok",
        uptime: process.uptime(),
    });
};
