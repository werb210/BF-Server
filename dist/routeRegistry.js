import lenderRoutes from "./modules/lender/lender.routes.js";
export function registerRoutes(app) {
    app.use("/api/lender", lenderRoutes);
}
