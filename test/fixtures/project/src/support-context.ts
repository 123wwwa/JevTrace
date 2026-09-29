const retryStatusCodes = [408, 429, 500];
const retryAfterStatusCodes = [429, 503];

const defaultRetryOptions = {
  statusCodes: retryStatusCodes,
  afterStatusCodes: retryAfterStatusCodes,
  maxRetryAfter: Number.POSITIVE_INFINITY,
};

export function normalizeRetryOptions(input: Partial<typeof defaultRetryOptions>) {
  return { ...defaultRetryOptions, ...input };
}

export function retryDelay() {
  return normalizeRetryOptions({}).afterStatusCodes.includes(429);
}
