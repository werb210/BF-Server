import { pool } from "../db.js";
import { fetchLenderById, listLenders } from "../repositories/lenders.repo.js";
export async function listLendersService() {
    return listLenders(pool);
}
export async function fetchLenderByIdService(id) {
    return fetchLenderById(id);
}
