import { pool, runQuery } from "../db.js";
import { fetchLenderById, listLenders } from "../repositories/lenders.repo.js";

export async function listLendersService() {
  return listLenders(pool);
}

export async function fetchLenderByIdService(
  id: string
): Promise<Awaited<ReturnType<typeof fetchLenderById>> | null> {
  return fetchLenderById(id);
}
