import { searchVideosWithAdFilters, isVideoEmbeddable } from './youtube';
import { downloadAudio } from './audioDownload';
import { transcribeAudio } from './whisper';
import { getCaptions } from './captions';
import { findMatchingSegment, detectSentenceBoundary } from './sentenceDetector';
import { insertVideoExample } from '../db/videoExamples';
import {
  updateJobStatus,
  updateJobResult,
  updateJobError,
  JobResult,
  CaptionSegment,
} from '../db/jobQueue';
import {
  extractWords,
  addVideoToWordIndex,
  VideoResponse
} from '../db/wordIndex';
import fs from 'fs';
import path from 'path';

// Check if transcription appears to be in English
function isEnglishTranscription(captions: any[]): boolean {
  if (captions.length === 0) return false;

  const commonEnglishWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for', 'on', 'with', 'as', 'this', 'be', 'at'];
  const allText = captions.map((c: any) => c.text).join(' ').toLowerCase();

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

// Generate multiple search strategies for better results
function getSearchStrategies(normalizedQuery: string, queryType: 'word' | 'sentence'): string[] {
  const strategies: string[] = [];

  if (queryType === 'word') {
    // For single words, use educational content first
    strategies.push(`"${normalizedQuery}" explained`);
    strategies.push(`${normalizedQuery} explained`);
    strategies.push(normalizedQuery);
    strategies.push(`"${normalizedQuery}"`);
  } else {
    // For multi-word phrases/sentences, prioritize exact matches
    strategies.push(`"${normalizedQuery}"`); // Exact phrase match
    strategies.push(normalizedQuery); // Natural match
    strategies.push(`${normalizedQuery} example`); // With context
    strategies.push(`"${normalizedQuery}" explained`); // Educational
  }

  return strategies;
}

export async function processJob(
  hash: string,
  normalizedQuery: string,
  queryType: 'word' | 'sentence' = 'word'
): Promise<void> {
  const JOB_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes timeout
  const startTime = Date.now();

  // Helper to check if job has exceeded timeout
  const checkTimeout = () => {
    if (Date.now() - startTime > JOB_TIMEOUT_MS) {
      throw new Error(`Job timeout: exceeded ${JOB_TIMEOUT_MS / 1000}s limit`);
    }
  };

  try {
    console.log(`\n===== Processing job for: "${normalizedQuery}" (type: ${queryType}) =====`);

    // Step 1: Update status to searching
    await updateJobStatus(hash, 'searching');
    console.log(`Status: SEARCHING`);

    // Step 2: Try multiple search strategies
    const strategies = getSearchStrategies(normalizedQuery, queryType);
    let allVideos: any[] = [];

    for (const searchQuery of strategies) {
      console.log(`\nTrying search strategy: "${searchQuery}"`);
      // Use ad-filtering search to minimize ads in results
      const videos = await searchVideosWithAdFilters(searchQuery, 5);
      console.log(`Found ${videos.length} videos`);

      // Add videos that we haven't seen yet (deduplicate by videoId)
      const existingIds = new Set(allVideos.map(v => v.videoId));
      const newVideos = videos.filter(v => !existingIds.has(v.videoId));
      allVideos = [...allVideos, ...newVideos];

      // Stop collecting if we have enough videos
      if (allVideos.length >= 10) {
        console.log(`Collected ${allVideos.length} unique videos, starting processing...`);
        break;
      }
    }

    console.log(`\nTotal unique videos to process: ${allVideos.length}`);

    if (allVideos.length === 0) {
      await updateJobError(hash, 'No videos found for this query');
      return;
    }

    // Step 3: Loop through videos to find English video with matching word
    for (let i = 0; i < allVideos.length; i++) {
      checkTimeout(); // Check timeout before processing each video

      const video = allVideos[i];
      console.log(`\nProcessing video ${i + 1}/${allVideos.length}: ${video.videoId} - "${video.title}"`);

      try {
        // Step 3a: Check if video is embeddable
        const embeddable = await isVideoEmbeddable(video.videoId);
        if (!embeddable) {
          console.log(`  ⚠️ Video ${video.videoId} is not embeddable, skipping...`);
          continue;
        }
        console.log(`  ✓ Video is embeddable`);

        // Step 3b: Update status to downloading
        await updateJobStatus(hash, 'downloading', video.videoId);
        console.log(`Status: DOWNLOADING (Video: ${video.videoId})`);

        const audioResult = await downloadAudio(video.videoId);
        console.log(`  Audio downloaded: ${audioResult.filePath} (${audioResult.fileSizeMB} MB)`);

        // Step 3c: Update status to transcribing
        await updateJobStatus(hash, 'transcribing', video.videoId);
        console.log(`Status: TRANSCRIBING (Video: ${video.videoId})`);

        const useGPU = process.env.USE_GPU === 'true';
        const whisperResult = await transcribeAudio(audioResult.filePath, video.videoId, normalizedQuery, 30, 10, useGPU);
        console.log(`  Transcription completed: ${whisperResult.vttPath}`);
        if (whisperResult.stoppedEarly) {
          console.log(`  ⚡ Early stopping: processed only ${whisperResult.chunksProcessed} chunks!`);
        }

        // Step 3d: Get captions from VTT file
        const captions = await getCaptions(video.videoId);
        console.log(`  Loaded ${captions.length} caption segments`);

        // Step 3e: Check if transcription is in English
        const isEnglish = isEnglishTranscription(captions);
        if (!isEnglish) {
          console.log(`  ⚠️ Transcription not in English, skipping to next video...`);
          cleanupTempFiles(video.videoId);
          continue;
        }
        console.log(`  ✓ Transcription validated as English`);

        // Step 3f: Find matching segment
        const matchIndex = findMatchingSegment(captions, normalizedQuery, queryType);

        if (matchIndex === -1) {
          console.log(`  No match found for "${normalizedQuery}", trying next video...`);
          cleanupTempFiles(video.videoId);
          continue;
        }

        console.log(`  ✓ Match found at segment index: ${matchIndex}`);

        // Step 3g: Detect sentence boundary
        const boundary = detectSentenceBoundary(captions, matchIndex);

        // Filter captions to only include segments within the matched range
        const filteredCaptions: CaptionSegment[] = captions
          .filter(c => {
            const segmentEnd = c.start + c.duration;
            return c.start < boundary.endTime && segmentEnd > boundary.startTime;
          })
          .map(c => ({
            start: c.start,
            end: c.start + c.duration,
            text: c.text
          }));

        const result: JobResult = {
          videoId: video.videoId,
          videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
          startTime: boundary.startTime,
          endTime: boundary.endTime,
          caption: boundary.caption,
          captions: filteredCaptions
        };

        // Step 4: Update job with result (marks as completed)
        await updateJobResult(hash, result);
        console.log(`Status: COMPLETED`);

        // Step 5: Save to cache (video_examples table)
        try {
          await insertVideoExample({
            hash,
            query: normalizedQuery,
            videoId: video.videoId,
            startTime: boundary.startTime,
            endTime: boundary.endTime,
            caption: boundary.caption,
            captions: filteredCaptions
          });
          console.log(`  ✓ Result cached for future queries`);
        } catch (cacheError: any) {
          console.error(`  Warning: Failed to cache result: ${cacheError.message}`);
        }

        // Step 6: Index all words from the captions
        try {
          const words = extractWords(boundary.caption);
          console.log(`  Indexing ${words.length} unique words...`);

          const videoResponse: VideoResponse = {
            videoId: video.videoId,
            videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
            startTime: boundary.startTime,
            endTime: boundary.endTime,
            caption: boundary.caption,
            captions: filteredCaptions
          };

          await addVideoToWordIndex(words, videoResponse);
          console.log(`  ✓ Word index updated`);
        } catch (indexError: any) {
          console.error(`  Warning: Failed to index words: ${indexError.message}`);
        }

        // Cleanup temp files after extracting all data
        cleanupTempFiles(video.videoId);

        console.log(`\n===== Job completed successfully for: "${normalizedQuery}" =====\n`);
        return;
      } catch (error: any) {
        console.error(`  Error processing video ${i + 1}: ${error.message}`);
        cleanupTempFiles(video.videoId);
        continue;
      }
    }

    // If we get here, no suitable video was found
    await updateJobError(
      hash,
      `No English video found with the word "${normalizedQuery}". Tried ${allVideos.length} videos.`
    );
    console.log(`Status: FAILED - No suitable video found`);
  } catch (error: any) {
    console.error(`Error processing job for "${normalizedQuery}":`, error);
    await updateJobError(hash, error.message || 'Internal processing error');
  }
}
