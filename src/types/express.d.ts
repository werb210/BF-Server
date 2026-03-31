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
      user?: any;
    }
  }
}

export {};
