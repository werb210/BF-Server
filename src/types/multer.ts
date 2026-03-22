import type { Request } from "express";

export interface MulterRequest extends Request {
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>;
}
