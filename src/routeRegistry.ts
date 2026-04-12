import lenderRoutes from "./modules/lender/lender.routes.js";

export function registerRoutes(app: any) {
  app.use("/lender", lenderRoutes);
}
