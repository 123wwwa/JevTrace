import { MessageParser, publishResult, transformMessage } from './message-helpers.js';
import { metric, trace } from './noise.js';

export function processMessage(raw: string): string {
  trace(raw);
  const parser = new MessageParser(true);
  const parsed = parser.parse(raw);
  const transformed = transformMessage(parsed);
  metric('message.processed');
  return publishResult(transformed);
}
