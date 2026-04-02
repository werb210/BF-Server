import cors from "cors";

export const corsMiddleware = cors({
  origin: ["https://boreal.financial", "https://portal.boreal.financial"],
  credentials: true,
});
