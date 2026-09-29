// Loaded with `node --import` inside the container: records the provider-reported usage of every Jev call
// so jevgrep's cost is measured the same way as JevTrace's (response usage.cost / input tokens).
import fs from 'node:fs';

const out = process.env.JEVGREP_PROBE_OUT;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  if (out) {
    try {
      const body = await response.clone().json();
      fs.appendFileSync(out, JSON.stringify({ status: response.status, usage: body?.usage ?? null }) + '\n');
    } catch {
      fs.appendFileSync(out, JSON.stringify({ status: response.status, usage: null, unparsed: true }) + '\n');
    }
  }
  return response;
};
