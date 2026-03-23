import lenderRoutes from "./modules/lender/lender.routes";

export function registerRoutes(app: any) {
  app.use("/api/lender", lenderRoutes);
}
