import { isVideoEmbeddable, fetchVideoStatistics } from './youtube';
import { downloadAudio } from './audioDownload';
import { transcribeAudio } from './whisper';
import { getCaptions } from './captions';
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

// Cleanup temporary files
function cleanupTempFiles(videoId: string): void {
  try {
    const tempDir = path.join(process.cwd(), 'temp');
    const audioPath = path.join(tempDir, `${videoId}.mp3`);
    const vttPath = path.join(tempDir, `${videoId}.vtt`);

    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
      console.log(`  Deleted temp audio: ${audioPath}`);
    }

    if (fs.existsSync(vttPath)) {
      fs.unlinkSync(vttPath);
      console.log(`  Deleted temp VTT: ${vttPath}`);
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
  const sentences: SentenceBoundary[] = [];

  if (captions.length === 0) return sentences;

  let sentenceStartIndex = 0;

  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const trimmedText = caption.text.trim();

    // Check if this caption ends with sentence-ending punctuation
    if (/[.!?]$/.test(trimmedText) || i === captions.length - 1) {
      // Collect all captions from start to current
      const captionParts: string[] = [];
      for (let j = sentenceStartIndex; j <= i; j++) {
        captionParts.push(captions[j].text);
      }

      const startSegment = captions[sentenceStartIndex];
      const endSegment = captions[i];
      const startTime = startSegment.start;
      const endTime = endSegment.start + endSegment.duration + 0.5; // Small buffer

      const captionText = captionParts.join(' ').trim();

      // Only add if we have meaningful content (at least 2 words)
      const wordCount = captionText.split(/\s+/).filter(w => w.length > 0).length;
      if (wordCount >= 2) {
        sentences.push({
          startTime,
          endTime,
          caption: captionText
        });
      }

      // Start next sentence from the next caption
      sentenceStartIndex = i + 1;
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
  maxChunks: number = 1000
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

    // Step 2: Update status to downloading
    await updateJobStatus(hash, 'downloading', videoId);
    console.log(`Status: DOWNLOADING (Video: ${videoId})`);

    const audioResult = await downloadAudio(videoId);
    console.log(`  Audio downloaded: ${audioResult.filePath} (${audioResult.fileSizeMB} MB)`);

    checkTimeout();

    // Step 3: Update status to transcribing
    await updateJobStatus(hash, 'transcribing', videoId);
    console.log(`Status: TRANSCRIBING (Video: ${videoId})`);

    const useGPU = process.env.USE_GPU === 'true';
    // For full video indexing, don't use early stopping - transcribe the entire video
    // Use a unique marker that won't be found in video content to prevent early stopping
    // Pass a large maxChunks value to process all chunks (30s each, 1000 chunks = ~8 hours of video)
    const FULL_TRANSCRIPTION_MARKER = '__XYZFULLVIDEOXYZ12345__';
    const whisperResult = await transcribeAudio(
      audioResult.filePath,
      videoId,
      FULL_TRANSCRIPTION_MARKER, // Use unique marker that won't match to process all chunks
      30, // 30 second chunks (standard)
      maxChunks, // Configurable limit (1000 for full video, 30 for trending ~15min)
      useGPU
    );
    console.log(`  Transcription completed: ${whisperResult.vttPath}`);

    checkTimeout();

    // Step 4: Get captions from VTT file
    const captions = await getCaptions(videoId);
    console.log(`  Loaded ${captions.length} caption segments`);

    // Step 5: Check if transcription is in English
    const isEnglish = isEnglishTranscription(captions);
    if (!isEnglish) {
      cleanupTempFiles(videoId);
      await updateJobError(hash, 'Video transcription is not in English');
      return;
    }
    console.log(`  ✓ Transcription validated as English`);

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
      const filteredCaptions: JobCaptionSegment[] = captions
        .filter(c => {
          const segmentEnd = c.start + c.duration;
          return c.start < sentence.endTime && segmentEnd > sentence.startTime;
        })
        .map(c => ({
          start: c.start,
          end: c.start + c.duration,
          text: c.text
        }));

      const videoResponse: VideoResponse = {
        videoId: videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        startTime: sentence.startTime,
        endTime: sentence.endTime,
        caption: sentence.caption,
        captions: filteredCaptions,
        ...(popularity ? { popularity } : {}),
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
