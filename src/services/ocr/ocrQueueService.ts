import { ocrQueue } from "../../queue/ocrQueue.js"

export async function queueOCRJob(data:any){

  return ocrQueue.add(
    "ocr",
    data
  )

}
