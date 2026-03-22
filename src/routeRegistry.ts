import lenderRoutes from "./modules/lender/lender.routes";
import readinessRoutes from "./routes/readiness";

export function registerRoutes(app: any) {
  app.use("/api/lender", lenderRoutes);
  app.use("/api/system", readinessRoutes);
}
