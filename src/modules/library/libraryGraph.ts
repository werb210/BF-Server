// BF_SERVER_v810_LIBRARY_PLUS - OneDrive (Microsoft Graph) calls for the Staff Library. Every call names the
// library's drive and an item id; the caller's own Microsoft sign-in is used, so OneDrive's permissions apply.
import type { GraphClient } from "../o365/graphClient.js";

export const ITEM_ID_RE = /^[A-Za-z0-9!_.-]{1,200}$/;
export const isItemId = (v: unknown): v is string => typeof v === "string" && ITEM_ID_RE.test(v);

export class LibraryGraphError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: string) { super(message); }
}

export type LibraryItem = {
  id: string; name: string; webUrl: string | null; size: number | null; lastModified: string | null; isFolder: boolean;
  mimeType: string | null; modifiedBy: string | null; childCount: number | null; thumbnailUrl: string | null; parentId: string | null; path: string | null;
};

export function mapLibraryItem(i: any): LibraryItem {
  const thumb = Array.isArray(i?.thumbnails) && i.thumbnails[0] ? (i.thumbnails[0].medium?.url ?? i.thumbnails[0].small?.url ?? null) : null;
  return {
    id: String(i?.id ?? ""), name: String(i?.name ?? ""), webUrl: i?.webUrl ?? null, size: typeof i?.size === "number" ? i.size : null,
    lastModified: i?.lastModifiedDateTime ?? null, isFolder: !!i?.folder,
    mimeType: i?.file?.mimeType ?? null,
    modifiedBy: i?.lastModifiedBy?.user?.displayName ?? i?.lastModifiedBy?.application?.displayName ?? null,
    childCount: typeof i?.folder?.childCount === "number" ? i.folder.childCount : null,
    thumbnailUrl: thumb, parentId: i?.parentReference?.id ?? null, path: i?.parentReference?.path ?? null,
  };
}

export function sortItems(items: LibraryItem[]): LibraryItem[] {
  return items.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name));
}

async function fail(r: Response, code: string, message: string): Promise<never> {
  const detail = (await r.text().catch(() => "")).slice(0, 400);
  const status = r.status === 401 || r.status === 403 ? 412 : r.status === 404 ? 404 : r.status === 409 ? 409 : 502;
  throw new LibraryGraphError(status, code, message, detail);
}

export function itemPath(driveId: string, itemId: string): string {
  return "/drives/" + encodeURIComponent(driveId) + "/items/" + encodeURIComponent(itemId);
}

export async function getItem(graph: GraphClient, driveId: string, itemId: string): Promise<any> {
  const r = await graph.fetch(itemPath(driveId, itemId) + "?$expand=thumbnails");
  if (!r.ok) await fail(r, "item_failed", "That file or folder could not be found.");
  return r.json();
}

// All children of a folder (follows paging), with thumbnails when OneDrive has them.
export async function listChildren(graph: GraphClient, driveId: string, folderId: string, max = 1000): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = itemPath(driveId, folderId) + "/children?$top=200&$expand=thumbnails";
  while (next && out.length < max) {
    const r: Response = await graph.fetch(next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, ""));
    if (!r.ok) await fail(r, "library_list_failed", "Could not load the folder.");
    const j: any = await r.json();
    out.push(...(j.value ?? []));
    next = typeof j["@odata.nextLink"] === "string" ? j["@odata.nextLink"] : null;
  }
  return out;
}

export async function searchLibrary(graph: GraphClient, driveId: string, rootId: string, q: string): Promise<any[]> {
  const term = q.replace(/'/g, "''").slice(0, 120);
  const r = await graph.fetch(itemPath(driveId, rootId) + "/search(q='" + encodeURIComponent(term) + "')?$top=100&$expand=thumbnails");
  if (!r.ok) await fail(r, "search_failed", "Search did not work. Try again.");
  return ((await r.json()) as any).value ?? [];
}

export async function previewUrl(graph: GraphClient, driveId: string, itemId: string): Promise<string | null> {
  const r = await graph.fetch(itemPath(driveId, itemId) + "/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) return null;
  return (((await r.json()) as any)?.getUrl as string) ?? null;
}

export async function downloadUrl(graph: GraphClient, driveId: string, itemId: string): Promise<{ url: string; name: string; size: number; mimeType: string }> {
  const r = await graph.fetch(itemPath(driveId, itemId) + "?$select=id,name,size,file,folder,@microsoft.graph.downloadUrl");
  if (!r.ok) await fail(r, "item_failed", "That file could not be found.");
  const j: any = await r.json();
  if (j.folder || !j["@microsoft.graph.downloadUrl"]) throw new LibraryGraphError(400, "not_a_file", "That is a folder, not a file.");
  return { url: j["@microsoft.graph.downloadUrl"], name: j.name, size: Number(j.size ?? 0), mimeType: j.file?.mimeType ?? "application/octet-stream" };
}

export async function patchItem(graph: GraphClient, driveId: string, itemId: string, body: Record<string, unknown>, renameOnConflict = false): Promise<any> {
  const r = await graph.fetch(itemPath(driveId, itemId) + (renameOnConflict ? "?@microsoft.graph.conflictBehavior=rename" : ""), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 409) throw new LibraryGraphError(409, "name_taken", "Something with that name is already there. Pick another name.");
  if (!r.ok) await fail(r, "update_failed", "OneDrive did not accept the change.");
  return r.json();
}

export async function deleteItem(graph: GraphClient, driveId: string, itemId: string): Promise<void> {
  const r = await graph.fetch(itemPath(driveId, itemId), { method: "DELETE" });
  if (!r.ok && r.status !== 404) await fail(r, "delete_failed", "OneDrive did not delete it.");
}

export async function ensureFolder(graph: GraphClient, driveId: string, parentId: string, name: string): Promise<any> {
  const r = await graph.fetch(itemPath(driveId, parentId) + "/children", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  if (r.ok) return r.json();
  if (r.status === 409) {
    const g = await graph.fetch(itemPath(driveId, parentId) + ":/" + encodeURIComponent(name));
    if (g.ok) return g.json();
    await fail(g, "folder_failed", "Could not open the folder.");
  }
  return fail(r, "folder_failed", "Could not create the folder.");
}

export async function listVersions(graph: GraphClient, driveId: string, itemId: string): Promise<any[]> {
  const r = await graph.fetch(itemPath(driveId, itemId) + "/versions");
  if (!r.ok) await fail(r, "versions_failed", "Could not load the versions.");
  return (((await r.json()) as any).value ?? []).map((v: any) => ({
    id: String(v.id), lastModified: v.lastModifiedDateTime ?? null, size: typeof v.size === "number" ? v.size : null,
    modifiedBy: v.lastModifiedBy?.user?.displayName ?? null,
  }));
}

export async function restoreVersion(graph: GraphClient, driveId: string, itemId: string, versionId: string): Promise<void> {
  const r = await graph.fetch(itemPath(driveId, itemId) + "/versions/" + encodeURIComponent(versionId) + "/restoreVersion", { method: "POST" });
  if (!r.ok) await fail(r, "restore_failed", "OneDrive did not restore that version.");
}

// Upload bytes into a folder through an upload session, in OneDrive-sized pieces.
export async function uploadBuffer(graph: GraphClient, driveId: string, folderId: string, name: string, content: Buffer, chunkBytes: number): Promise<any> {
  const s = await graph.fetch(itemPath(driveId, folderId) + ":/" + encodeURIComponent(name) + ":/createUploadSession", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  });
  if (!s.ok) await fail(s, "upload_failed", "OneDrive did not accept the upload.");
  const uploadUrl: string = ((await s.json()) as any)?.uploadUrl;
  let start = 0;
  for (;;) {
    const end = Math.min(start + chunkBytes, content.length);
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(end - start), "Content-Range": "bytes " + start + "-" + (end - 1) + "/" + content.length },
      body: new Uint8Array(content.subarray(start, end)),
    });
    if (put.status === 200 || put.status === 201) return put.json();
    if (put.status !== 202) await fail(put, "upload_failed", "The upload stopped part way.");
    start = end;
    if (start >= content.length) throw new LibraryGraphError(502, "upload_failed", "OneDrive did not finish the upload.");
  }
}
