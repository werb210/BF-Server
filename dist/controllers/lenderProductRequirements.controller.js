"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchLenderRequirements = exports.deleteLenderProductRequirementHandler = exports.updateLenderProductRequirementHandler = exports.createLenderProductRequirementHandler = exports.listLenderProductRequirementsHandler = void 0;
const listLenderProductRequirementsHandler = async (_req, res) => {
    res["json"]({ success: true, data: [] });
};
exports.listLenderProductRequirementsHandler = listLenderProductRequirementsHandler;
const createLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, created: true });
};
exports.createLenderProductRequirementHandler = createLenderProductRequirementHandler;
const updateLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, updated: true });
};
exports.updateLenderProductRequirementHandler = updateLenderProductRequirementHandler;
const deleteLenderProductRequirementHandler = async (_req, res) => {
    res["json"]({ success: true, deleted: true });
};
exports.deleteLenderProductRequirementHandler = deleteLenderProductRequirementHandler;
// aliases (backward compatibility)
exports.fetchLenderRequirements = exports.listLenderProductRequirementsHandler;
