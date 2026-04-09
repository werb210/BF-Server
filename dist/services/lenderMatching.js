import { enforceMatchingRules } from '../middleware/contractEnforcement.js';
export function matchLenders(application, products) {
    return products.filter(product => {
        enforceMatchingRules({
            lenderHQUsed: false
        });
        return product.countries.includes(application.country);
    });
}
