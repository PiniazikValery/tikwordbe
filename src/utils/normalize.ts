export interface NormalizedQuery {
  normalized: string;
  type: 'word' | 'sentence';
}

export function normalizeQuery(query: string): NormalizedQuery {
  // Trim whitespace
  const trimmed = query.trim();

  // Reject input longer than 200 characters
  if (trimmed.length > 200) {
    throw new Error('Query exceeds maximum length of 200 characters');
  }

  if (trimmed.length === 0) {
    throw new Error('Query cannot be empty');
  }

  // Convert to lowercase
  const normalized = trimmed.toLowerCase();

  // Detect query type
  // word → no spaces
  // sentence → contains spaces or punctuation
  const hasSpaces = /\s/.test(normalized);
  const hasPunctuation = /[.,!?;:]/.test(normalized);
  const type: 'word' | 'sentence' = hasSpaces || hasPunctuation ? 'sentence' : 'word';

  return {
    normalized,
    type
  };
}
