export class MessageParser {
  constructor(private readonly strict: boolean) {}

  parse(raw: string): string {
    return this.strict ? raw.trim() : raw;
  }
}

export function sanitizePayload(value: string): string {
  return value.replaceAll('<', '');
}

export function transformMessage(value: string): string {
  return sanitizePayload(value).toUpperCase();
}

export function publishResult(value: string): string {
  return `published:${value}`;
}
