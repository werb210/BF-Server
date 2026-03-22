import { Handler } from "../types/handler";

export const wrap = (fn: Handler): Handler => {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("HANDLER ERROR:", err);
      res.status(500).json({
        success: false,
        error: "Internal Server Error",
      });
    }
  };
};
