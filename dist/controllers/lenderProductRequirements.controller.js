export const listLenderProductRequirementsHandler = async (_req, res) => {
    res["json"]({ success: true, data: [] });
};
export const createLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, created: true });
};
export const updateLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, updated: true });
};
export const deleteLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, deleted: true });
};
// aliases (backward compatibility)
export const fetchLenderRequirements = listLenderProductRequirementsHandler;
