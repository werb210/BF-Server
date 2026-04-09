export const aiHandler = async (_req, res) => {
    res["json"]({ success: true, message: "AI alive" });
};
export const chat = aiHandler;
export const closeSession = aiHandler;
export const createContinuation = aiHandler;
export const escalate = aiHandler;
// alias for older routes
export const tagStartupInterest = aiHandler;
