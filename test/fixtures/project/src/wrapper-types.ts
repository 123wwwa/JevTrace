export interface WrapperOnly {
  value: string;
}

export function deepTyped(value: string): string {
  return value.trim();
}

export function wrapperTyped(value: string): string {
  const state: WrapperOnly = { value };
  return deepTyped(state.value);
}

export function typedEntry(value: string): string {
  return wrapperTyped(value);
}
