// BF_SERVER_v789_SG5 - the text a pdf-lib document draws, for asserting on what a generated PDF prints.
// pdf-lib writes standard-font text as hex strings (<48656C6C6F> Tj) inside flate-compressed
// content streams; this inflates every page's streams and decodes those strings.
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

export async function pdfTextRuns(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    if (!contents) continue;
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const ref of refs) {
      const stream = (ref instanceof PDFRawStream ? ref : doc.context.lookup(ref as any)) as PDFRawStream;
      const raw = Buffer.from(stream.contents);
      const ops = (stream.dict.get(PDFName.of("Filter")) ? inflateSync(raw) : raw).toString("latin1");
      for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) runs.push(Buffer.from(m[1]!, "hex").toString("latin1"));
      for (const m of ops.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) runs.push(m[1]!.replace(/\\(.)/g, "$1"));
    }
  }
  return runs;
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  return (await pdfTextRuns(bytes)).join("\n");
}
