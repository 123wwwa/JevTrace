import { normalizeQuery, ProductRepository, rankResults } from './search-helpers.js';
import { audit, metric } from './noise.js';

const repository = new ProductRepository();

export function searchProducts(query: string): string[] {
  audit(query);
  const normalized = normalizeQuery(query);
  const results = repository.search(normalized);
  metric('search.query');
  return rankResults(results);
}
