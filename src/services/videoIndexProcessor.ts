import { isVideoEmbeddable, fetchVideoStatistics } from './youtube';
import { downloadSubtitles } from './subtitleDownload';
import { downloadAudio } from './audioDownload';
import { transcribeAudio } from './whisper';
import { isWhisperAvailable } from './dockerCheck';
import { getCaptions, groupWordCaptions } from './captions';
import { CaptionSegment, SentenceBoundary } from './sentenceDetector';
import {
  updateJobStatus,
  updateJobResult,
  updateJobError,
  CaptionSegment as JobCaptionSegment,
} from '../db/jobQueue';
import {
  extractWords,
  addVideoToWordIndex,
  VideoResponse
} from '../db/wordIndex';
import { PopularityScore, buildPopularityScore } from '../utils/popularity';
import { markVideoIndexed } from '../db/indexedVideos';
import fs from 'fs';
import path from 'path';

// Check if transcription appears to be in English
function isEnglishTranscription(captions: CaptionSegment[]): boolean {
  if (captions.length === 0) return false;

  const commonEnglishWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for', 'on', 'with', 'as', 'this', 'be', 'at'];
  const allText = captions.map(c => c.text).join(' ').toLowerCase();

  let englishWordCount = 0;
  commonEnglishWords.forEach(word => {
    if (allText.includes(` ${word} `) || allText.startsWith(`${word} `) || allText.endsWith(` ${word}`)) {
      englishWordCount++;
    }
  });

  const nonLatinChars = allText.match(/[^\x00-\x7F]/g);
  const nonLatinRatio = nonLatinChars ? nonLatinChars.length / allText.length : 0;

  return englishWordCount >= 5 && nonLatinRatio < 0.2;
}

// Check if captions are mostly music/non-speech (e.g. music videos, ambient sounds)
function isMusicOrNonSpeech(captions: CaptionSegment[]): boolean {
  if (captions.length === 0) return true;

  const allText = captions.map(c => c.text).join(' ');
  const totalLength = allText.length;
  if (totalLength === 0) return true;

  // Count [Music], [Applause], [Laughter] etc. tag characters
  const tagMatches = allText.match(/\[[\w\s]+\]/gi) || [];
  const tagLength = tagMatches.reduce((sum, tag) => sum + tag.length, 0);
  const tagRatio = tagLength / totalLength;

  // Count segments that are purely non-speech tags
  const nonSpeechSegments = captions.filter(c => {
    const stripped = c.text.replace(/\[[\w\s]+\]/gi, '').trim();
    return stripped.length === 0;
  }).length;
  const nonSpeechRatio = nonSpeechSegments / captions.length;

  // Check for very sparse speech — music videos have short bursts of lyrics with long gaps
  const totalDuration = captions.length > 0
    ? captions[captions.length - 1].start + captions[captions.length - 1].duration - captions[0].start
    : 0;
  const speechSegments = captions.filter(c => c.text.replace(/\[[\w\s]+\]/gi, '').trim().length > 0);
  const speechDuration = speechSegments.reduce((sum, c) => sum + c.duration, 0);
  const speechRatio = totalDuration > 0 ? speechDuration / totalDuration : 0;

  // Average words per segment (low for music lyrics — short phrases)
  const totalWords = speechSegments.reduce((sum, c) => {
    return sum + c.text.replace(/\[[\w\s]+\]/gi, '').trim().split(/\s+/).filter(w => w.length > 0).length;
  }, 0);
  const avgWordsPerSegment = speechSegments.length > 0 ? totalWords / speechSegments.length : 0;

  console.log(`  [MusicCheck] totalSegments=${captions.length}, nonSpeechSegments=${nonSpeechSegments} (${(nonSpeechRatio * 100).toFixed(1)}%), tagRatio=${(tagRatio * 100).toFixed(1)}%, speechRatio=${(speechRatio * 100).toFixed(1)}%, avgWordsPerSeg=${avgWordsPerSegment.toFixed(1)}, totalDuration=${totalDuration.toFixed(0)}s`);
  console.log(`  [MusicCheck] First 5 captions: ${captions.slice(0, 5).map(c => JSON.stringify(c.text)).join(', ')}`);
  console.log(`  [MusicCheck] Sample from middle: ${captions.slice(Math.floor(captions.length / 2), Math.floor(captions.length / 2) + 3).map(c => JSON.stringify(c.text)).join(', ')}`);

  // If more than 30% of text is tags, or more than 40% of segments are non-speech, it's music
  if (tagRatio > 0.3 || nonSpeechRatio > 0.4) {
    console.log(`  [MusicCheck] REJECTED: high tag/non-speech ratio`);
    return true;
  }

  // If speech covers less than 20% of total duration, it's likely music
  if (totalDuration > 30 && speechRatio < 0.2) {
    console.log(`  [MusicCheck] REJECTED: sparse speech (${(speechRatio * 100).toFixed(1)}% of duration)`);
    return true;
  }

  // Detect word-level VTT (each segment ≈ 1 word with very short duration)
  // Word-level VTTs have avg segment duration < 1.5s — skip words-per-segment check for those
  const avgSegmentDuration = speechSegments.length > 0
    ? speechDuration / speechSegments.length
    : 0;
  const isWordLevelVTT = avgSegmentDuration < 1.5 && avgWordsPerSegment <= 1.5;

  // Music lyrics tend to have very few words per caption segment (1-2 words each)
  // Normal speech has 3+ words per segment on average
  if (!isWordLevelVTT && avgWordsPerSegment < 2 && speechSegments.length > 20) {
    console.log(`  [MusicCheck] REJECTED: low words per segment (${avgWordsPerSegment.toFixed(1)} avg) — likely lyrics`);
    return true;
  }

  if (isWordLevelVTT) {
    console.log(`  [MusicCheck] Detected word-level VTT (${avgSegmentDuration.toFixed(2)}s avg segment duration) — skipping words-per-segment check`);
  }

  console.log(`  [MusicCheck] PASSED: appears to be speech content`);
  return false;
}

// Cleanup temporary files
function cleanupTempFiles(videoId: string): void {
  try {
    const tempDir = path.join(process.cwd(), 'temp');
    const audioPath = path.join(tempDir, `${videoId}.mp3`);
    const vttPath = path.join(tempDir, `${videoId}.vtt`);
    const ytdlpVttPath = path.join(tempDir, `${videoId}.en.vtt`);

    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
      console.log(`  Deleted temp audio: ${audioPath}`);
    }

    if (fs.existsSync(vttPath)) {
      fs.unlinkSync(vttPath);
      console.log(`  Deleted temp VTT: ${vttPath}`);
    }

    if (fs.existsSync(ytdlpVttPath)) {
      fs.unlinkSync(ytdlpVttPath);
      console.log(`  Deleted temp yt-dlp VTT: ${ytdlpVttPath}`);
    }
  } catch (error: any) {
    console.error(`  Error cleaning up temp files: ${error.message}`);
  }
}

/**
 * Split captions into sentence-based segments
 * Each segment represents a complete sentence (or fragment if no punctuation found)
 */
function splitIntoSentences(captions: CaptionSegment[]): SentenceBoundary[] {
  const MIN_SENTENCE_DURATION = 30; // seconds — merge short sentences until this minimum
  const MAX_SENTENCE_DURATION = 60; // seconds — force-split if no punctuation found
  const sentences: SentenceBoundary[] = [];

  if (captions.length === 0) return sentences;

  let sentenceStartIndex = 0;

  const flushSentence = (endIndex: number, force: boolean = false) => {
    const startSegment = captions[sentenceStartIndex];
    const endSegment = captions[endIndex];
    const rawDuration = endSegment.start + endSegment.duration - startSegment.start;

    // Don't flush if below minimum duration — skip short fragments entirely
    if (rawDuration < MIN_SENTENCE_DURATION) {
      console.log(`  [Split] Skipping short fragment (${rawDuration.toFixed(1)}s < ${MIN_SENTENCE_DURATION}s, force=${force}): "${captions.slice(sentenceStartIndex, endIndex + 1).map(c => c.text).join(' ').substring(0, 80)}..."`);
      if (force) {
        // Even when forced, discard fragments shorter than minimum — they're scraps
        sentenceStartIndex = endIndex + 1;
      }
      return;
    }

    const captionParts: string[] = [];
    for (let j = sentenceStartIndex; j <= endIndex; j++) {
      captionParts.push(captions[j].text);
    }

    const startTime = Math.max(0, startSegment.start);
    const endTime = endSegment.start + endSegment.duration;

    const captionText = captionParts.join(' ').trim();

    // Strip [Music]/[Applause] tags and check for real speech
    const speechText = captionText.replace(/\[[\w\s]+\]/gi, '').trim();

    // Only add if we have meaningful speech content (at least 2 real words)
    const wordCount = speechText.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount >= 2) {
      console.log(`  [Split] Created fragment #${sentences.length + 1}: ${rawDuration.toFixed(1)}s (${startTime.toFixed(1)}s-${endTime.toFixed(1)}s), ${wordCount} words: "${captionText.substring(0, 100)}..."`);
      sentences.push({
        startTime,
        endTime,
        caption: captionText
      });
    } else {
      console.log(`  [Split] Discarded fragment (only ${wordCount} word(s)): "${captionText.substring(0, 80)}"`);
    }

    sentenceStartIndex = endIndex + 1;
  };

  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const trimmedText = caption.text.trim();
    const currentStart = captions[sentenceStartIndex].start;
    const currentDuration = caption.start + caption.duration - currentStart;

    // Force-split if duration exceeds max cap (even without punctuation)
    if (currentDuration > MAX_SENTENCE_DURATION && i > sentenceStartIndex) {
      flushSentence(i - 1, true);
    }

    // Try to split on punctuation — but only if minimum duration is met
    if (/[.!?]$/.test(trimmedText)) {
      flushSentence(i);
    }

    // Force flush at end of captions
    if (i === captions.length - 1 && sentenceStartIndex <= i) {
      flushSentence(i, true);
    }
  }

  return sentences;
}

/**
 * Process a video for indexing - transcribe and index all words from all sentences
 */
export async function processVideoIndex(
  hash: string,
  videoId: string,
  existingPopularity?: PopularityScore,
  maxChunks: number = 1000,
  clipStartTime?: number,
  clipEndTime?: number,
  source: string = 'auto'
): Promise<void> {
  const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes timeout (longer for full video)
  const startTime = Date.now();

  // Helper to check if job has exceeded timeout
  const checkTimeout = () => {
    if (Date.now() - startTime > JOB_TIMEOUT_MS) {
      throw new Error(`Job timeout: exceeded ${JOB_TIMEOUT_MS / 1000}s limit`);
    }
  };

  try {
    console.log(`\n===== Processing video index for: ${videoId} =====`);

    // Step 1: Check if video is embeddable
    const embeddable = await isVideoEmbeddable(videoId);
    if (!embeddable) {
      await updateJobError(hash, `Video ${videoId} is not embeddable`);
      return;
    }
    console.log(`  ✓ Video is embeddable`);

    // Step 1b: Get popularity score
    let popularity: PopularityScore | undefined = existingPopularity;
    if (!popularity) {
      try {
        const stats = await fetchVideoStatistics(videoId);
        if (stats) {
          popularity = buildPopularityScore(stats);
          console.log(`  ✓ Popularity score: ${popularity.score} (views: ${stats.viewCount})`);
        }
      } catch (error: any) {
        console.log(`  ⚠ Could not fetch video statistics: ${error.message}`);
      }
    } else {
      console.log(`  ✓ Using provided popularity score: ${popularity.score}`);
    }

    // Step 2: Try fetching subtitles first (fast path — no audio download needed)
    await updateJobStatus(hash, 'downloading', videoId);
    let captions: CaptionSegment[] = [];
    let usedSubtitles = false;

    const subtitleResult = await downloadSubtitles(videoId);
    if (subtitleResult.success) {
      captions = await getCaptions(videoId);
      if (captions.length > 0 && isEnglishTranscription(captions) && !isMusicOrNonSpeech(captions)) {
        usedSubtitles = true;
        console.log(`  ✓ Using YouTube subtitles (${captions.length} segments)`);
      } else {
        console.log(`  ⚠️ Subtitles not usable (empty, not English, or mostly music), falling back to Whisper...`);
        cleanupTempFiles(videoId);
        captions = [];
      }
    }

    // Step 3: Fallback to audio download + Whisper transcription
    if (!usedSubtitles) {
      if (!isWhisperAvailable()) {
        console.log(`  ⚠️ No subtitles and Whisper not available, cannot process video`);
        await updateJobError(hash, 'No subtitles available and Whisper is not installed');
        return;
      }

      console.log(`Status: DOWNLOADING (Video: ${videoId})`);

      const audioResult = await downloadAudio(videoId);
      console.log(`  Audio downloaded: ${audioResult.filePath} (${audioResult.fileSizeMB} MB)`);

      checkTimeout();

      await updateJobStatus(hash, 'transcribing', videoId);
      console.log(`Status: TRANSCRIBING (Video: ${videoId})`);

      const useGPU = process.env.USE_GPU === 'true';
      const FULL_TRANSCRIPTION_MARKER = '__XYZFULLVIDEOXYZ12345__';
      const whisperResult = await transcribeAudio(
        audioResult.filePath,
        videoId,
        FULL_TRANSCRIPTION_MARKER,
        30,
        maxChunks,
        useGPU
      );
      console.log(`  Transcription completed: ${whisperResult.vttPath}`);

      checkTimeout();

      captions = await getCaptions(videoId);
      console.log(`  Loaded ${captions.length} caption segments`);

      const isEnglish = isEnglishTranscription(captions);
      if (!isEnglish) {
        cleanupTempFiles(videoId);
        await updateJobError(hash, 'Video transcription is not in English');
        return;
      }
      console.log(`  ✓ Transcription validated as English`);

      if (isMusicOrNonSpeech(captions)) {
        cleanupTempFiles(videoId);
        await updateJobError(hash, 'Video is mostly music or non-speech content');
        return;
      }
      console.log(`  ✓ Validated as speech-heavy content`);
    }

    // Step 5b: Filter captions to time range if specified
    if (clipStartTime !== undefined || clipEndTime !== undefined) {
      const before = captions.length;
      captions = captions.filter(c => {
        const segEnd = c.start + c.duration;
        if (clipStartTime !== undefined && segEnd <= clipStartTime) return false;
        if (clipEndTime !== undefined && c.start >= clipEndTime) return false;
        return true;
      });
      console.log(`  Filtered captions to time range [${clipStartTime ?? 0}s - ${clipEndTime ?? 'end'}s]: ${before} → ${captions.length} segments`);

      if (captions.length === 0) {
        await updateJobError(hash, `No captions found in time range [${clipStartTime ?? 0}s - ${clipEndTime ?? 'end'}s]`);
        cleanupTempFiles(videoId);
        return;
      }
    }

    // Step 6: Split into sentences
    await updateJobStatus(hash, 'searching', videoId); // Using 'searching' as 'indexing' status
    console.log(`Status: INDEXING (Video: ${videoId})`);

    const sentences = splitIntoSentences(captions);
    console.log(`  Split into ${sentences.length} sentence segments`);

    // Step 7: Index all words from all sentences
    let totalWordsIndexed = 0;
    const uniqueWords = new Set<string>();

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];

      // Create filtered captions for this sentence
      const rawFilteredCaptions: JobCaptionSegment[] = captions
        .filter(c => {
          const segmentEnd = c.start + c.duration;
          return c.start < sentence.endTime && segmentEnd > sentence.startTime;
        })
        .map(c => ({
          start: c.start,
          end: c.start + c.duration,
          text: c.text
        }));

      // Group word-level captions into natural phrases for display
      const filteredCaptions = groupWordCaptions(rawFilteredCaptions);

      // Use actual caption boundaries for startTime/endTime so they match the captions array
      const actualStart = filteredCaptions.length > 0 ? filteredCaptions[0].start : sentence.startTime;
      const actualEnd = filteredCaptions.length > 0 ? filteredCaptions[filteredCaptions.length - 1].end : sentence.endTime;

      const videoResponse: VideoResponse = {
        videoId: videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        startTime: actualStart,
        endTime: actualEnd,
        caption: sentence.caption,
        captions: filteredCaptions,
        ...(popularity ? { popularity } : {}),
        source,
      };

      // Extract and index words
      const words = extractWords(sentence.caption);
      words.forEach(word => uniqueWords.add(word));

      await addVideoToWordIndex(words, videoResponse);

      if ((i + 1) % 10 === 0) {
        console.log(`  Indexed ${i + 1}/${sentences.length} sentences...`);
        checkTimeout();
      }
    }

    totalWordsIndexed = uniqueWords.size;
    console.log(`  ✓ Indexed ${totalWordsIndexed} unique words from ${sentences.length} sentences`);

    // Step 8: Mark video as indexed
    await markVideoIndexed(
      videoId,
      '',
      popularity?.score,
      popularity?.viewCount,
      popularity?.likeCount,
      popularity?.commentCount
    );
    console.log(`  ✓ Video marked as indexed`);

    // Step 9: Cleanup temp files
    cleanupTempFiles(videoId);

    // Step 10: Update job with result
    await updateJobResult(hash, {
      videoId: videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      startTime: 0,
      endTime: 0,
      caption: '',
      captions: [],
      // Additional fields for video indexing
      segmentsIndexed: sentences.length,
      wordsIndexed: totalWordsIndexed
    } as any);

    console.log(`Status: COMPLETED`);
    console.log(`\n===== Video index completed for: ${videoId} =====\n`);

  } catch (error: any) {
    console.error(`Error processing video index for "${videoId}":`, error);
    cleanupTempFiles(videoId);
    await updateJobError(hash, error.message || 'Internal processing error');
  }
}
