import { createHash } from 'node:crypto';

export function hash(value: unknown, length = 16): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, length);
}
