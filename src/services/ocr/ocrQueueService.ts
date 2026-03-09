import { ocrQueue } from "../../queue/ocrQueue"

export async function queueOCRJob(data:any){

  return ocrQueue.add(
    "ocr",
    data
  )

}
