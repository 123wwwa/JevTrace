export function checkMime(data: string): boolean {
  return data.startsWith('image/');
}

export function validateAvatar(data: string): boolean {
  return checkMime(data);
}

export function storageWrite(data: string): string {
  return `avatars/${data.length}.bin`;
}

export function persistAvatar(data: string): string {
  return storageWrite(data);
}

export function publicUrl(path: string): string {
  return `https://cdn.example/${path}`;
}
