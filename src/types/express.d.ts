import "express";
import { type AuthenticatedUser } from "./auth";

declare module "express-serve-static-core" {
  interface Request {
    id: string;
    requestId?: string;
    log?: {
      info: (...args: any[]) => void;
      error: (...args: any[]) => void;
      warn: (...args: any[]) => void;
      debug: (...args: any[]) => void;
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
