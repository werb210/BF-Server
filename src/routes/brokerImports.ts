import { Router } from "express"; import multer from "multer"; import { pool } from "../db.js"; import { requireAuth,requireAuthorization } from "../middleware/auth.js"; import { ROLES } from "../auth/roles.js"; import { safeHandler } from "../middleware/safeHandler.js"; import { importBrokerZip,BrokerImportError } from "../services/brokerImport/importBrokerFile.js";
const router=Router(),staff=[requireAuth,requireAuthorization({roles:[ROLES.ADMIN,ROLES.STAFF]})],upload=multer({storage:multer.memoryStorage(),limits:{fileSize:100*1024*1024,files:1}});
router.post("/",...staff,upload.single("file"),safeHandler(async(req:any,res:any)=>{const file=req.file as Express.Multer.File|undefined,brokerName=String(req.body?.broker_name??"").trim();if(!file)return res.status(400).json({error:"file_required",message:"Attach the client's zip file."});if(!/\.zip$/i.test(file.originalname))return res.status(400).json({error:"zip_required",message:"Upload a .zip file (one per client)."});if(!brokerName)return res.status(400).json({error:"broker_required",message:"Choose which broker this file came from."});try{return res.status(201).json(await importBrokerZip({zip:file.buffer,zipName:file.originalname,brokerName,uploadedBy:req.user?.id?String(req.user.id):null,applicantPhone:req.body?.applicant_phone}))}catch(e){if(e instanceof BrokerImportError)return res.status(e.status).json({error:e.code,message:e.message,details:e.details??null});return res.status(500).json({error:"import_failed",message:(e as Error).message})}}));
router.get("/",...staff,safeHandler(async(_req:any,res:any)=>{const r=await pool.query(`SELECT bi.*,a.name AS business_name,a.pipeline_state,d.boreal_pct,d.broker_pct,d.terms AS deal_terms FROM broker_imports bi LEFT JOIN applications a ON a.id::text=bi.application_id LEFT JOIN broker_deal_confirmations d ON d.application_id=bi.application_id ORDER BY bi.created_at DESC LIMIT 100`);res.json({imports:r.rows})}));
router.get("/deal/:applicationId",...staff,safeHandler(async(req:any,res:any)=>{const r=await pool.query(`SELECT * FROM broker_deal_confirmations WHERE application_id=$1 LIMIT 1`,[String(req.params.applicationId)]);res.json({deal:r.rows[0]??null})}));
router.put("/deal/:applicationId",...staff,safeHandler(async(req:any,res:any)=>{const id=String(req.params.applicationId),b=req.body??{},pct=(v:unknown)=>v==null||v===""?null:Number(v),bp=pct(b.boreal_pct),pp=pct(b.broker_pct),terms=String(b.terms??"").trim()||null;if([bp,pp].some(v=>v!=null&&(!Number.isFinite(v)||v<0||v>100)))return res.status(400).json({error:"bad_percent"});if(bp!=null&&pp!=null&&Math.abs(bp+pp-100)>.01)return res.status(400).json({error:"split_not_100"});if(bp==null&&pp==null&&!terms)return res.status(400).json({error:"split_required"});const app=await pool.query<{broker_name:string|null}>(`SELECT metadata->'broker_import'->>'broker_name' AS broker_name FROM applications WHERE id::text=$1 LIMIT 1`,[id]);if(!app.rows[0])return res.status(404).json({error:"not_found"});const r=await pool.query(`INSERT INTO broker_deal_confirmations (application_id,broker_name,boreal_pct,broker_pct,terms,notes,agreed_by_broker,agreed_on,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9) ON CONFLICT(application_id) DO UPDATE SET boreal_pct=EXCLUDED.boreal_pct,broker_pct=EXCLUDED.broker_pct,terms=EXCLUDED.terms,notes=EXCLUDED.notes,agreed_by_broker=EXCLUDED.agreed_by_broker,agreed_on=EXCLUDED.agreed_on,recorded_by=EXCLUDED.recorded_by,updated_at=now() RETURNING *`,[id,app.rows[0].broker_name??"Partner broker",bp,pp,terms,String(b.notes??"").trim()||null,String(b.agreed_by_broker??"").trim()||null,/^\d{4}-\d{2}-\d{2}$/.test(String(b.agreed_on??""))?b.agreed_on:new Date().toISOString().slice(0,10),req.user?.id?String(req.user.id):null]);res.json({deal:r.rows[0]})}));
// BF_SERVER_BLOCK_v530 - staff actions on an imported file before the client signs in.
async function brokerAction(res: any, run: () => Promise<unknown>) {
  const { BrokerImportError } = await import("../services/brokerImport/importBrokerFile.js");
  try { res.json({ ok: true, ...(await run() as object ?? {}) }); }
  catch (e) {
    if (e instanceof BrokerImportError) return res.status(e.status).json({ error: e.code, message: e.message, details: e.details ?? null });
    return res.status(502).json({ error: "broker_action_failed", message: (e as Error)?.message ?? "failed" });
  }
}
router.put("/:id/phone", ...staff, safeHandler(async (req: any, res: any) => {
  const { setBrokerImportPhone } = await import("../services/brokerImport/actions.js");
  await brokerAction(res, () => setBrokerImportPhone(String(req.params.id), req.body?.applicant_phone));
}));
router.post("/:id/text-client", ...staff, safeHandler(async (req: any, res: any) => {
  const { textBrokerClient } = await import("../services/brokerImport/actions.js");
  await brokerAction(res, () => textBrokerClient(String(req.params.id)));
}));
router.post("/:id/discard", ...staff, safeHandler(async (req: any, res: any) => {
  const { discardBrokerImport } = await import("../services/brokerImport/actions.js");
  await brokerAction(res, () => discardBrokerImport(String(req.params.id)));
}));
export default router;
