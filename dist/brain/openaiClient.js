export async function runAI(source, message, history, context = {}) {
    if (context?.role && context.role !== "staff" && context.role !== "system") {
        return Promise.reject({
            code: "forbidden",
            status: 403,
        });
    }
    return { text: "ok" };
}
