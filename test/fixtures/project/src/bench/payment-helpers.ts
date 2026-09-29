export function loadPayment(id: string) {
  return { id, attempt: 2, failed: true };
}

export function shouldRetry(payment: { failed: boolean; attempt: number }): boolean {
  return payment.failed && payment.attempt < 5;
}

export function exponentialBackoff(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

export function calculateRetryDelay(attempt: number): number {
  return exponentialBackoff(attempt);
}

export function scheduleRetry(payment: { id: string }, delay: number): string {
  return `${payment.id}:${delay}`;
}
