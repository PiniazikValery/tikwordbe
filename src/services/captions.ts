import fs from 'fs';
import path from 'path';
import { CaptionSegment } from './sentenceDetector';

/**
 * Strip HTML/VTT tags and decode HTML entities from subtitle text.
 * Handles both raw tags (<font>) and HTML-encoded tags (&lt;font&gt;).
 */
function cleanSubtitleText(text: string): string {
  return text
    // Decode HTML entities first (YouTube VTT often has pre-encoded tags)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Strip VTT voice tags: <v Speaker>text</v>
    .replace(/<v[^>]*>/gi, '')
    .replace(/<\/v>/gi, '')
    // Strip HTML tags: <font>, <b>, <i>, <u>, <c>, etc.
    .replace(/<[^>]+>/g, '')
    // Strip VTT class annotations: <c.colorE5E5E5>
    .replace(/<c\.[^>]*>/gi, '')
    // Remove bracketed annotations like [look after] that some subs include
    .replace(/\[[^\]]*\]/g, '')
    // Remove VTT speaker indicators (>> or >>Name:)
    .replace(/>>\s*[\w\s]*:/g, '')
    .replace(/>>/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(':');
  let seconds = 0;

  if (parts.length === 3) {
    // HH:MM:SS.mmm
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    // MM:SS.mmm
    seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }

  return seconds;
}

interface RawCue {
  text: string;
  start: number;
  end: number;
}

interface WordTimestamp {
  word: string;
  start: number;
}

/**
 * Quick check: does the VTT content contain YouTube word-level <c> timing tags?
 */
function hasWordTimestamps(vttContent: string): boolean {
  return /<\d{2}:\d{2}:\d{2}\.\d{3}><c>/.test(vttContent);
}

/**
 * Find how many characters at the end of `a` match the beginning of `b`.
 * Returns the length of the overlap, or 0 if none.
 */
function findSuffixPrefixOverlap(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length);
  for (let len = maxLen; len >= 4; len--) {
    // Check if the last `len` chars of `a` equal the first `len` chars of `b`
    if (a.endsWith(b.substring(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Parse word-level timestamps from a YouTube auto-generated VTT cue line.
 *
 * Format: "FirstWord<00:00:01.200><c> second</c><00:00:01.800><c> third</c>"
 * - The first word has no <c> tag; its timestamp is the cue start time.
 * - Subsequent words: <TIMESTAMP><c> word</c>
 *
 * Returns null if no <c> tags are found (Whisper VTT or plain text fallback line).
 */
function parseWordTimestamps(line: string, cueStartTime: number): WordTimestamp[] | null {
  if (!line.includes('<c>') && !line.includes('<c ')) {
    return null;
  }

  const words: WordTimestamp[] = [];

  // Extract leading text before the first timestamp (first word of the cue)
  const firstWordMatch = line.match(/^([^<]*?)(?:<\d{2}:\d{2}:\d{2}\.\d{3}>|$)/);
  if (firstWordMatch && firstWordMatch[1].trim()) {
    words.push({
      word: firstWordMatch[1].trim(),
      start: cueStartTime,
    });
  }

  // Match all <TIMESTAMP><c> word</c> patterns
  const pattern = /<(\d{2}:\d{2}:\d{2}\.\d{3})><c>(.*?)<\/c>/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const timestamp = parseTimestamp(match[1]);
    const wordText = match[2].trim();
    if (wordText) {
      words.push({
        word: wordText,
        start: timestamp,
      });
    }
  }

  return words.length > 0 ? words : null;
}

/**
 * Parse YouTube auto-generated VTT with word-level timestamps from <c> tags.
 * Produces one CaptionSegment per word with precise timing.
 */
function parseVTTWordLevel(vttContent: string): CaptionSegment[] {
  const lines = vttContent.split('\n');
  const allWords: WordTimestamp[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const [startStr, endStrRaw] = line.split('-->').map(s => s.trim());
      const endStr = endStrRaw.split(' ')[0];
      const cueStart = parseTimestamp(startStr);

      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const rawLine = lines[i];
        const wordTimestamps = parseWordTimestamps(rawLine, cueStart);

        if (wordTimestamps) {
          for (const wt of wordTimestamps) {
            allWords.push(wt);
          }
        }
        // Lines without <c> tags are plain-text fallback duplicates — skip
        i++;
      }
    }
    i++;
  }

  // Deduplicate: YouTube rolling cues produce the same word at the same timestamp
  const seen = new Set<string>();
  const uniqueWords: WordTimestamp[] = [];
  for (const w of allWords) {
    const key = `${w.start.toFixed(3)}|${w.word.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueWords.push(w);
    }
  }

  // Sort by start time
  uniqueWords.sort((a, b) => a.start - b.start);

  // Convert to CaptionSegment[]: duration = next word's start - this word's start
  const DEFAULT_LAST_WORD_DURATION = 0.5;
  const MAX_WORD_DURATION = 5;

  const segments: CaptionSegment[] = uniqueWords.map((w, idx) => {
    const cleanedWord = cleanSubtitleText(w.word);
    let duration: number;
    if (idx < uniqueWords.length - 1) {
      duration = uniqueWords[idx + 1].start - w.start;
      if (duration > MAX_WORD_DURATION) duration = MAX_WORD_DURATION;
      if (duration <= 0) duration = DEFAULT_LAST_WORD_DURATION;
    } else {
      duration = DEFAULT_LAST_WORD_DURATION;
    }

    return {
      text: cleanedWord,
      start: w.start,
      duration,
    };
  });

  return segments.filter(s => s.text.length > 0);
}

function parseVTTCueLevel(vttContent: string): CaptionSegment[] {
  const lines = vttContent.split('\n');

  // Phase 1: Parse all raw cues from the VTT file
  const rawCues: RawCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const [startStr, endStrRaw] = line.split('-->').map(s => s.trim());
      // YouTube VTT may have style attrs after timestamp: "00:00:06.000 align:start position:0%"
      // Strip everything after the timestamp (first space-separated token)
      const endStr = endStrRaw.split(' ')[0];
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);

      i++;
      const cueLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const cleanLine = cleanSubtitleText(lines[i]);
        if (cleanLine) {
          cueLines.push(cleanLine);
        }
        i++;
      }

      // YouTube auto-subs put 2 lines per cue where line 2 = line 1 + new words.
      // Keep only the longest non-prefix line from each group.
      let text = '';
      for (const cl of cueLines) {
        if (!text) {
          text = cl;
        } else if (cl.startsWith(text)) {
          // This line supersedes the previous — keep the longer version
          text = cl;
        } else {
          text += ' ' + cl;
        }
      }

      if (text) {
        rawCues.push({ text, start, end });
      }
    }

    i++;
  }

  // Phase 2: Deduplicate overlapping YouTube auto-sub cues.
  // YouTube auto-subs have partial overlaps between cues:
  //   cue1: "Welcome back to our series of English pronunciation videos."
  //   cue2: "English pronunciation videos. Let's take a look"
  // The suffix of cue1 matches the prefix of cue2. We detect this and
  // trim the overlapping prefix from the later cue.
  const deduped: RawCue[] = [];
  for (let j = 0; j < rawCues.length; j++) {
    const current = rawCues[j];
    const prev = deduped[deduped.length - 1];

    if (!prev) {
      deduped.push(current);
      continue;
    }

    // Exact duplicate — skip
    if (current.text === prev.text) continue;

    // Current is entirely contained in prev — skip
    if (prev.text.includes(current.text)) continue;

    // Current fully supersedes prev (prev is a prefix of current)
    if (current.text.startsWith(prev.text)) {
      prev.text = current.text;
      prev.end = current.end;
      continue;
    }

    // Partial suffix/prefix overlap: end of prev matches start of current
    const overlap = findSuffixPrefixOverlap(prev.text, current.text);
    if (overlap > 0) {
      // Trim the overlapping prefix from current
      const trimmedText = current.text.substring(overlap).trim();
      if (trimmedText) {
        deduped.push({ text: trimmedText, start: current.start, end: current.end });
      }
      // If trimmedText is empty, current was fully contained — just skip
      continue;
    }

    deduped.push(current);
  }

  // Phase 3: Drop cues with absurdly long durations (e.g. 166s "[Music] oh")
  // These are typically non-speech filler in auto-generated subs
  const MAX_CUE_DURATION = 30; // seconds
  const cleaned = deduped.filter(cue => {
    const duration = cue.end - cue.start;
    if (duration > MAX_CUE_DURATION) {
      console.log(`  Dropping oversized cue (${duration.toFixed(1)}s): "${cue.text.substring(0, 50)}..."`);
      return false;
    }
    return true;
  });

  // Phase 4: Convert to CaptionSegments
  const segments: CaptionSegment[] = cleaned.map(cue => ({
    text: cue.text,
    start: cue.start,
    duration: cue.end - cue.start
  }));

  return segments;
}

function parseVTT(vttContent: string): CaptionSegment[] {
  if (hasWordTimestamps(vttContent)) {
    const wordSegments = parseVTTWordLevel(vttContent);
    if (wordSegments.length > 0) {
      return wordSegments;
    }
    // Fall through to cue-level if word parsing produced nothing
  }
  return parseVTTCueLevel(vttContent);
}

interface StoredCaptionSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Group word-level captions into natural phrase-level segments.
 * When captions come from YouTube word-level timestamps, each segment is a single word.
 * This function merges consecutive words into phrases for more natural display.
 *
 * Splitting heuristics:
 * - Pause gap > 0.7s between words → new phrase
 * - Max ~8 words per phrase (split at next pause or boundary)
 * - Punctuation at end of a word triggers a split
 */
export function groupWordCaptions(captions: StoredCaptionSegment[]): StoredCaptionSegment[] {
  if (captions.length === 0) return captions;

  // Detect if these are word-level: check if the majority of segments are single words
  const singleWordCount = captions.filter(c => !c.text.includes(' ')).length;
  const isWordLevel = singleWordCount / captions.length > 0.8;

  if (!isWordLevel) {
    // Already phrase-level, return as-is
    return captions;
  }

  const PAUSE_THRESHOLD = 0.7; // seconds — gap between words that triggers a new phrase
  const MAX_WORDS_PER_PHRASE = 8;
  const PUNCTUATION_PATTERN = /[.!?,;:]$/;

  const grouped: StoredCaptionSegment[] = [];
  let currentWords: string[] = [];
  let phraseStart = captions[0].start;
  let phraseEnd = captions[0].end;

  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const nextCap = captions[i + 1];

    currentWords.push(cap.text);
    phraseEnd = cap.end;

    const shouldSplit =
      // Last caption
      !nextCap ||
      // Pause between current and next word
      (nextCap.start - cap.end > PAUSE_THRESHOLD) ||
      // Hit max words per phrase
      currentWords.length >= MAX_WORDS_PER_PHRASE ||
      // Punctuation at end of word
      PUNCTUATION_PATTERN.test(cap.text);

    if (shouldSplit && currentWords.length > 0) {
      grouped.push({
        start: phraseStart,
        end: phraseEnd,
        text: currentWords.join(' ')
      });
      currentWords = [];
      if (nextCap) {
        phraseStart = nextCap.start;
      }
    }
  }

  return grouped;
}

export async function getCaptions(videoId: string): Promise<CaptionSegment[]> {
  try {
    console.log(`  Reading captions from VTT file for video: ${videoId}`);

    // Look for VTT file - check both Whisper format and yt-dlp format
    const whisperVttPath = path.join(process.cwd(), 'temp', `${videoId}.vtt`);
    const ytdlpVttPath = path.join(process.cwd(), 'temp', `${videoId}.en.vtt`);

    let vttPath: string;
    if (fs.existsSync(whisperVttPath)) {
      vttPath = whisperVttPath;
      console.log('  Using Whisper-generated VTT');
    } else if (fs.existsSync(ytdlpVttPath)) {
      vttPath = ytdlpVttPath;
      console.log('  Using yt-dlp VTT');
    } else {
      console.log('  VTT file not found');
      throw new Error('No captions available for this video');
    }

    const vttContent = fs.readFileSync(vttPath, 'utf-8');
    const segments = parseVTT(vttContent);

    if (segments.length === 0) {
      console.log('  No caption segments parsed');
      throw new Error('No captions available for this video');
    }

    console.log(`  Parsed ${segments.length} caption segments from VTT`);

    return segments;
  } catch (error: any) {
    console.log(`  Error reading captions: ${error.message}`);
    throw new Error('No captions available for this video');
  }
}
