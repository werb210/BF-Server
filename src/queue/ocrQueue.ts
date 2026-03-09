import { Queue } from "bullmq"
import { redisConnection } from "./redis"

export const OCR_QUEUE_NAME = "ocr-processing"

export const ocrQueue = new Queue(OCR_QUEUE_NAME,{
  connection: redisConnection,
  defaultJobOptions:{
    attempts:3,
    backoff:{
      type:"exponential",
      delay:30000
    },
    removeOnComplete:true,
    removeOnFail:false
  }
})
