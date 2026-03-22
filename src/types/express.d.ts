import { JwtPayload } from "jsonwebtoken";

export interface AuthenticatedUser extends JwtPayload {
  id?: string;
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      requestId?: string;
      log?: {
        info: (...args: any[]) => void;
        error: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        debug: (...args: any[]) => void;
      };
      user?: AuthenticatedUser;
    }
  }
}

export {};
