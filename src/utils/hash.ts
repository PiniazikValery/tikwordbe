import crypto from 'crypto';

export function generateHash(input: string): string {
  return crypto
    .createHash('sha256')
    .update(input)
    .digest('hex');
}
