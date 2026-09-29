export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function scoreProduct(name: string, query: string): number {
  return name.toLowerCase().includes(query) ? 1 : 0;
}

export class ProductRepository {
  search(query: string): string[] {
    return ['Alpha', 'Beta'].filter(name => scoreProduct(name, query) > 0);
  }
}

export function rankResults(results: string[]): string[] {
  return [...results].sort();
}
