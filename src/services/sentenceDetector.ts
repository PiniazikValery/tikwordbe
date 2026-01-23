export interface CaptionSegment {
  text: string;
  start: number;
  duration: number;
}

export interface SentenceBoundary {
  startTime: number;
  endTime: number;
  caption: string;
}

export function detectSentenceBoundary(
  segments: CaptionSegment[],
  matchIndex: number
): SentenceBoundary {
  // Step 1: Find the start of the sentence by looking backward
  let startIndex = matchIndex;

  // Look backward to find where the sentence actually starts
  for (let i = matchIndex - 1; i >= 0; i--) {
    const segment = segments[i];
    const trimmedText = segment.text.trim();

    // If we find sentence-ending punctuation, the sentence starts AFTER this segment
    if (/[.!?]$/.test(trimmedText)) {
      startIndex = i + 1;
      break;
    }

    // If we've reached the beginning, start from index 0
    if (i === 0) {
      startIndex = 0;
    }
  }

  // Step 2: Find the end of the sentence by looking forward
  let endIndex = matchIndex;

  // Look forward to find where the sentence ends
  for (let i = matchIndex; i < segments.length; i++) {
    const segment = segments[i];
    endIndex = i;

    // Check if this segment ends with sentence-ending punctuation
    const trimmedText = segment.text.trim();
    if (/[.!?]$/.test(trimmedText)) {
      break;
    }
  }

  // Step 3: Collect all caption parts from start to end
  const captionParts: string[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    captionParts.push(segments[i].text);
  }

  // Step 4: Calculate start and end times
  const startSegment = segments[startIndex];
  const endSegment = segments[endIndex];
  const startTime = startSegment.start;
  const endTime = endSegment.start + endSegment.duration + 2; // Add 2 seconds buffer

  // Step 5: Combine caption parts into a single sentence
  const caption = captionParts.join(' ').trim();

  return {
    startTime,
    endTime,
    caption
  };
}

// Helper to get word stem variations (simple approach)
function getWordVariations(word: string): string[] {
  const variations = [word];

  // Common verb endings
  if (word.endsWith('e')) {
    variations.push(word.slice(0, -1) + 'ing'); // dissect -> dissecting
    variations.push(word + 'd'); // dissect -> dissected
  }
  if (word.endsWith('t')) {
    variations.push(word + 'ion'); // dissect -> dissection
    variations.push(word + 'ed'); // dissect -> dissected
    variations.push(word + 'ing'); // dissect -> dissecting
  }

  // Remove common suffixes to get stem
  if (word.endsWith('ion')) {
    variations.push(word.slice(0, -3)); // dissection -> dissect
    variations.push(word.slice(0, -3) + 'ing'); // dissection -> dissecting
  }
  if (word.endsWith('ing')) {
    variations.push(word.slice(0, -3)); // dissecting -> dissect
    variations.push(word.slice(0, -3) + 'ion'); // dissecting -> dissection
  }
  if (word.endsWith('ed')) {
    variations.push(word.slice(0, -2)); // dissected -> dissect
  }

  return [...new Set(variations)]; // Remove duplicates
}

// Check if all query words appear in text (with variations, within context window)
function phraseMatchWithVariations(text: string, query: string): boolean {
  const queryWords = query.toLowerCase().split(/\s+/);
  const normalizedText = text.toLowerCase();

  // For each word in query, check if any variation appears
  for (const queryWord of queryWords) {
    const variations = getWordVariations(queryWord);
    const found = variations.some(variation => {
      const regex = new RegExp(`\\b${escapeRegExp(variation)}\\w*\\b`, 'i');
      return regex.test(normalizedText);
    });

    if (!found) {
      return false; // If any word is missing, no match
    }
  }

  return true;
}

export function findMatchingSegment(
  segments: CaptionSegment[],
  query: string,
  queryType: 'word' | 'sentence'
): number {
  const normalizedQuery = query.toLowerCase();

  // First pass: exact matches
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const normalizedText = segment.text.toLowerCase();

    if (queryType === 'word') {
      // For words: exact word boundary match preferred
      const wordRegex = new RegExp(`\\b${escapeRegExp(normalizedQuery)}\\b`, 'i');
      if (wordRegex.test(normalizedText)) {
        return i;
      }
    } else {
      // For sentences: exact phrase match
      if (normalizedText.includes(normalizedQuery)) {
        return i;
      }
    }
  }

  // Second pass: fuzzy matches with word variations
  if (queryType === 'sentence') {
    // For multi-word phrases, check within a context window (3 segments)
    for (let i = 0; i < segments.length; i++) {
      // Check current segment + next 2 segments as context
      const contextSegments = segments.slice(i, Math.min(i + 3, segments.length));
      const contextText = contextSegments.map(s => s.text).join(' ');

      if (phraseMatchWithVariations(contextText, normalizedQuery)) {
        return i;
      }
    }
  }

  // Third pass: simple fuzzy match for single words
  if (queryType === 'word') {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const normalizedText = segment.text.toLowerCase();
      if (normalizedText.includes(normalizedQuery)) {
        return i;
      }
    }
  }

  return -1;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
