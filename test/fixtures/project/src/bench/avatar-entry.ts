import { persistAvatar, publicUrl, validateAvatar } from './avatar-helpers.js';
import { audit, metric } from './noise.js';

export function uploadAvatar(data: string): string {
  metric('avatar.upload');
  if (!validateAvatar(data)) throw new Error('invalid avatar');
  const path = persistAvatar(data);
  audit(path);
  return publicUrl(path);
}
