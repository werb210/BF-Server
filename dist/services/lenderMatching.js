"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchLenders = matchLenders;
const contractEnforcement_1 = require("../middleware/contractEnforcement");
function matchLenders(application, products) {
    return products.filter(product => {
        (0, contractEnforcement_1.enforceMatchingRules)({
            lenderHQUsed: false
        });
        return product.countries.includes(application.country);
    });
}
