import { ocrQueue } from "../../queue/ocrQueue.js";
export async function queueOCRJob(data) {
    return ocrQueue.add("ocr", data);
}
