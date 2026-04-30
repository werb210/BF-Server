import archiver from "archiver";
import { Buffer } from "node:buffer";

export type DocumentInPackage = {
  filename: string;
  content: Buffer;
};

export type CategoryGroup = {
  category: string;
  files: DocumentInPackage[];
};

export type FlatFields = Array<{ label: string; value: string | number | boolean | null }>;

export type BuildPackageInput = {
  applicationId: string;
  signedApplicationPdf: Buffer | null;
  creditSummaryPdf: Buffer | null;
  fields: FlatFields;
  documents: CategoryGroup[];
};

export type BuildPackageOutput = {
  zipBuffer: Buffer;
  manifest: {
    applicationId: string;
    entries: string[];
    bytes: number;
  };
};

function renderFieldsPdf(fields: FlatFields): Buffer {
  const lines = fields.map((f) => `${f.label}: ${f.value === null ? "" : String(f.value)}`);
  const pdfEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let y = 770;
  const textOps: string[] = ["BT", "/F1 10 Tf", "14 TL"];
  textOps.push(`50 ${y} Td`);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) textOps.push("T*");
    textOps.push(`(${pdfEscape(lines[i] ?? "")}) Tj`);
    y -= 14;
    if (y < 50) break;
  }
  textOps.push("ET");
  const stream = textOps.join("\n");

  const objects: string[] = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj");
  objects.push("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj");
  objects.push(
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj"
  );
  objects.push(`4 0 obj << /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`);
  objects.push("5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj + "\n";
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

export async function buildApplicationPackage(input: BuildPackageInput): Promise<BuildPackageOutput> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];

  archive.on("data", (chunk) => {
    chunks.push(chunk as Buffer);
  });

  const closed = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (err) => reject(err));
  });

  const entries: string[] = [];

  if (input.signedApplicationPdf) {
    archive.append(input.signedApplicationPdf, { name: "signed-application.pdf" });
    entries.push("signed-application.pdf");
  }
  if (input.creditSummaryPdf) {
    archive.append(input.creditSummaryPdf, { name: "credit-summary.pdf" });
    entries.push("credit-summary.pdf");
  }

  const flatJson: Record<string, unknown> = {};
  for (const f of input.fields) flatJson[f.label] = f.value;
  archive.append(Buffer.from(JSON.stringify(flatJson, null, 2), "utf8"), { name: "application-fields.json" });
  entries.push("application-fields.json");

  archive.append(renderFieldsPdf(input.fields), { name: "application-fields.pdf" });
  entries.push("application-fields.pdf");

  for (const group of input.documents) {
    const folder = safeName(group.category);
    for (const f of group.files) {
      const entryName = `${folder}/${safeName(f.filename)}`;
      archive.append(f.content, { name: entryName });
      entries.push(entryName);
    }
  }

  await archive.finalize();
  await closed;

  const zipBuffer = Buffer.concat(chunks);
  return { zipBuffer, manifest: { applicationId: input.applicationId, entries, bytes: zipBuffer.length } };
}
