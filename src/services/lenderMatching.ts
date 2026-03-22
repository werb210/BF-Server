import { enforceMatchingRules } from '../middleware/contractEnforcement';

export function matchLenders(application: any, products: any[]) {
  return products.filter(product => {
    enforceMatchingRules({
      lenderHQUsed: false
    });

    return product.countries.includes(application.country);
  });
}
