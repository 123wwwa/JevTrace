import { calculateRetryDelay, loadPayment, scheduleRetry, shouldRetry } from './payment-helpers.js';
import { metric, trace } from './noise.js';

export function retryFailedPayment(id: string): string | undefined {
  trace(id);
  const payment = loadPayment(id);
  if (!shouldRetry(payment)) return undefined;
  const delay = calculateRetryDelay(payment.attempt);
  metric('payment.retry');
  return scheduleRetry(payment, delay);
}
