"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLendersService = listLendersService;
exports.fetchLenderByIdService = fetchLenderByIdService;
const db_1 = require("../db");
const lenders_repo_1 = require("../repositories/lenders.repo");
async function listLendersService() {
    return (0, lenders_repo_1.listLenders)(db_1.pool);
}
async function fetchLenderByIdService(id) {
    return (0, lenders_repo_1.fetchLenderById)(id);
}
