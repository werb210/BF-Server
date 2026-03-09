import { Worker } from "bullmq"
import { redisConnection } from "../queue/redis"
import { processOcrJob } from "../modules/ocr/ocr.service"
import { findOcrJobByDocumentId } from "../modules/ocr/ocr.repo"
import { logError, logInfo } from "../observability/logger"

const worker = new Worker(
  "ocr-processing",
  async (job) => {
    logInfo("ocr_queue_job_started", { jobId: job.id })

    const documentId = String(job.data?.documentId ?? "")
    if (!documentId) {
      throw new Error("missing_document_id")
    }

    const ocrJob = await findOcrJobByDocumentId(documentId)
    if (!ocrJob) {
      throw new Error(`ocr_job_not_found:${documentId}`)
    }

    await processOcrJob(ocrJob)

    logInfo("ocr_queue_job_completed", { jobId: job.id })
  },
  { connection: redisConnection }
)

worker.on("failed", (job, err) => {
  logError("ocr_queue_job_failed", {
    jobId: job?.id,
    error: err instanceof Error ? err.message : String(err),
  })
})
