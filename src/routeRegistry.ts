import lenderRoutes from "./modules/lender/lender.routes.js";

export function registerRoutes(app: any) {
  app.use("/api/lender", lenderRoutes);
}
