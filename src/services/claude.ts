import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY environment variable is required');
}

const anthropic = new Anthropic({
  apiKey: apiKey,
});

export interface ClaudeAnalysisResponse {
  fullTranslation: string;
  literalTranslation: string;
  grammarAnalysis: string;
  breakdown: Array<{
    word: string;
    baseForm: string;
    partOfSpeech: string;
    translation: string;
    meaningInSentence: string;
    function: string;
    usageInContext: string;
    alternativeMeanings: string[];
  }>;
  idioms: Array<{
    phrase: string;
    meaning: string;
    literalTranslation: string;
  }>;
  difficultyNotes?: string;
}

function buildPrompt(
  sentence: string,
  targetWord: string,
  targetLanguage: string,
  nativeLanguage: string,
  contextBefore?: string,
  contextAfter?: string
): string {
  return `You are a language learning assistant. A ${nativeLanguage} speaker is learning ${targetLanguage} and needs help understanding this sentence.

TARGET SENTENCE: "${sentence}"
TARGET WORD: "${targetWord}"
${contextBefore ? `PREVIOUS CONTEXT: "${contextBefore}"` : ''}
${contextAfter ? `FOLLOWING CONTEXT: "${contextAfter}"` : ''}

INSTRUCTIONS FOR BREAKDOWN ARRAY - FOCUS ON IMPORTANT WORDS:

**ALWAYS INCLUDE** (these are important for learning):
✓ THE TARGET WORD "${targetWord}" - MUST be included with detailed analysis
✓ ALL nouns (book, table, engine, cylinder)
✓ ALL main verbs (run, think, determine, multiply)
✓ ALL adjectives (big, small, large, technical)
✓ ALL adverbs (quickly, very, really, ultimately)
✓ Phrasal verbs (look up, give in, figure out)
✓ Technical or specialized terms
✓ Uncommon or difficult words
✓ Idioms and expressions
✓ Words related to the target word

**SKIP** (these are too basic for intermediate/advanced learners):
✗ Simple articles (a, an, the)
✗ Basic pronouns (I, you, he, she, it, we, they)
✗ Basic prepositions (in, on, at) - UNLESS part of phrasal verb
✗ Basic conjunctions (and, but, or)
✗ Simple auxiliary verbs (is, are, am) - UNLESS important for tense

**MANDATORY RULES**:
1. Provide ALL explanations, descriptions, and notes in ${nativeLanguage}
2. Only "word" and "baseForm" fields remain in ${targetLanguage}
3. Focus on words that help ${nativeLanguage} speakers learn ${targetLanguage}
4. Include context-specific meanings for each word

Return a JSON analysis with this exact structure:

{
  "fullTranslation": "Complete natural translation to ${nativeLanguage}",
  "literalTranslation": "Word-by-word literal translation to ${nativeLanguage}",
  "grammarAnalysis": "Detailed grammar explanation IN ${nativeLanguage}",
  "breakdown": [
    {
      "word": "each word from sentence (in ${targetLanguage})",
      "baseForm": "dictionary form (in ${targetLanguage})",
      "partOfSpeech": "part of speech IN ${nativeLanguage}",
      "translation": "dictionary translation IN ${nativeLanguage}",
      "meaningInSentence": "specific meaning in THIS sentence context IN ${nativeLanguage}",
      "function": "grammatical function IN ${nativeLanguage}",
      "usageInContext": "detailed explanation of how this word is used in this specific context, including any nuances, formality level, common usage patterns IN ${nativeLanguage}",
      "alternativeMeanings": ["other common meanings of this word with examples IN ${nativeLanguage}", "another meaning with example IN ${nativeLanguage}"]
    }
  ],
  "idioms": [
    {
      "phrase": "idiomatic expression (in ${targetLanguage})",
      "meaning": "meaning explained IN ${nativeLanguage}",
      "literalTranslation": "literal translation IN ${nativeLanguage}"
    }
  ],
  "difficultyNotes": "Notes about challenging aspects IN ${nativeLanguage}"
}

**QUALITY OVER QUANTITY**:
- Include all content words and difficult vocabulary
- Skip basic function words that don't help learning
- Typical sentence: 20-40 important words to analyze
- Focus on words that ${nativeLanguage} speakers need to understand

Return ONLY valid JSON, no additional text.`;
}

function validateClaudeResponse(response: any): ClaudeAnalysisResponse {
  // Extract text from Claude response format
  const content = response.content?.[0]?.text;
  if (!content) {
    throw new Error('No content in Claude API response');
  }

  // Parse JSON
  let parsed;
  try {
    // Strip markdown code fences if present
    let cleanedContent = content.trim();

    // Remove ```json and ``` if present
    if (cleanedContent.startsWith('```json')) {
      cleanedContent = cleanedContent.replace(/^```json\s*\n?/, '').replace(/\n?```\s*$/, '');
    } else if (cleanedContent.startsWith('```')) {
      cleanedContent = cleanedContent.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    parsed = JSON.parse(cleanedContent);
  } catch (error) {
    console.error('Failed to parse Claude response. Content:', content);
    console.error('Parse error:', error);
    throw new Error('Claude API returned invalid JSON');
  }

  // Validate required fields
  const required = [
    'fullTranslation',
    'literalTranslation',
    'grammarAnalysis',
    'breakdown',
    'idioms'
  ];

  for (const field of required) {
    if (!(field in parsed)) {
      throw new Error(`Missing required field in Claude response: ${field}`);
    }
  }

  // Validate arrays
  if (!Array.isArray(parsed.breakdown)) {
    throw new Error('breakdown must be an array');
  }

  if (!Array.isArray(parsed.idioms)) {
    throw new Error('idioms must be an array');
  }

  return parsed as ClaudeAnalysisResponse;
}

async function callClaudeAPIWithRetry(
  prompt: string,
  maxRetries: number = 3,
  timeoutMs: number = 600000
): Promise<any> {
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create timeout using Promise.race
      const apiCallPromise = anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
      });

      const response = await Promise.race([apiCallPromise, timeoutPromise]) as any;

      return response;

    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;

      // Don't retry on validation errors (400)
      if (error.status === 400) {
        throw new Error(`Invalid request to Claude API: ${error.message}`);
      }

      // Don't retry on authentication errors (401)
      if (error.status === 401) {
        throw new Error('Invalid Claude API key. Please check your ANTHROPIC_API_KEY environment variable.');
      }

      // Retry on rate limits (429), server errors (5xx), timeouts
      const shouldRetry =
        error.status === 429 ||
        (error.status >= 500 && error.status < 600) ||
        error.message === 'Request timeout';

      if (!shouldRetry || isLastAttempt) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Claude API attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function analyzeSentenceWithClaude(
  sentence: string,
  targetWord: string,
  targetLanguage: string,
  nativeLanguage: string,
  contextBefore?: string,
  contextAfter?: string
): Promise<ClaudeAnalysisResponse> {
  // Build prompt
  const prompt = buildPrompt(
    sentence,
    targetWord,
    targetLanguage,
    nativeLanguage,
    contextBefore,
    contextAfter
  );

  // Call Claude API with retry logic
  const response = await callClaudeAPIWithRetry(prompt);

  // Validate and return response
  return validateClaudeResponse(response);
}

export async function analyzeSentenceWithClaudeStream(
  sentence: string,
  targetWord: string,
  targetLanguage: string,
  nativeLanguage: string,
  onChunk: (text: string) => void,
  contextBefore?: string,
  contextAfter?: string
): Promise<string> {
  // Build prompt
  const prompt = buildPrompt(
    sentence,
    targetWord,
    targetLanguage,
    nativeLanguage,
    contextBefore,
    contextAfter
  );

  let fullResponse = '';

  try {
    const stream = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullResponse += chunk;
        onChunk(chunk);
      }
    }

    return fullResponse;
  } catch (error: any) {
    // Handle errors similar to non-streaming version
    if (error.status === 400) {
      throw new Error(`Invalid request to Claude API: ${error.message}`);
    }
    if (error.status === 401) {
      throw new Error('Invalid Claude API key. Please check your ANTHROPIC_API_KEY environment variable.');
    }
    throw error;
  }
}
