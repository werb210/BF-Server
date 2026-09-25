import { inflateRawSync } from "node:zlib";
export type ZipEntry = { name: string; data: Buffer };
export const ZIP_MAX_ENTRIES = 60;
export const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
export class ZipError extends Error {}
function eocd(b: Buffer) { for (let i=b.length-22;i>=Math.max(0,b.length-22-0xffff);i--) if (b.readUInt32LE(i)===0x06054b50) return i; throw new ZipError("Not a zip file (no end-of-directory record)."); }
export function readZip(buf: Buffer): ZipEntry[] {
  if(buf.length<22) throw new ZipError("File is too small to be a zip."); const end=eocd(buf), count=buf.readUInt16LE(end+10); let ptr=buf.readUInt32LE(end+16),total=0; const out:ZipEntry[]=[];
  for(let i=0;i<count;i++) { if(ptr+46>buf.length||buf.readUInt32LE(ptr)!==0x02014b50) throw new ZipError("Zip directory is damaged."); const flags=buf.readUInt16LE(ptr+8),method=buf.readUInt16LE(ptr+10),cs=buf.readUInt32LE(ptr+20),size=buf.readUInt32LE(ptr+24),nl=buf.readUInt16LE(ptr+28),xl=buf.readUInt16LE(ptr+30),cl=buf.readUInt16LE(ptr+32),lo=buf.readUInt32LE(ptr+42),name=buf.subarray(ptr+46,ptr+46+nl).toString(flags&0x800?"utf8":"latin1"); ptr+=46+nl+xl+cl; const base=name.split("/").pop()??""; if(name.endsWith("/")||!base||name.startsWith("__MACOSX/")||base.startsWith(".")) continue; if(flags&1) throw new ZipError(`"${base}" is password-protected. Send the zip without a password.`); if(out.length>=ZIP_MAX_ENTRIES) throw new ZipError(`Zip has more than ${ZIP_MAX_ENTRIES} files.`); total+=size;if(total>ZIP_MAX_TOTAL_BYTES) throw new ZipError("Zip contents are larger than 150 MB."); if(lo+30>buf.length||buf.readUInt32LE(lo)!==0x04034b50) throw new ZipError(`"${base}" is damaged in the zip.`); const start=lo+30+buf.readUInt16LE(lo+26)+buf.readUInt16LE(lo+28),raw=buf.subarray(start,start+cs); out.push({name:base,data:method===0?Buffer.from(raw):method===8?inflateRawSync(raw):(()=>{throw new ZipError(`"${base}" uses an unsupported compression method (${method}).`)})()}); }
  return out;
}
