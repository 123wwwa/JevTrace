export function deep(value: string): string {
  return value.trim();
}

export function wrapper(value: string): string {
  return deep(value);
}

export function helper(value: string): string {
  return value;
}

export function entry(value: string): string {
  const result = wrapper(value);
  return helper(result);
}
