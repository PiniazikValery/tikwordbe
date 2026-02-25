import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface SubtitleDownloadResult {
  success: boolean;
  vttPath: string;
}

/**
 * Attempt to download YouTube subtitles (auto-generated or manual) via yt-dlp.
 * Uses --skip-download so no video/audio is fetched — only subtitle files.
 * Output: {videoId}.en.vtt in the temp directory.
 */
export async function downloadSubtitles(videoId: string): Promise<SubtitleDownloadResult> {
  const outputDir = path.join(process.cwd(), 'temp');
  const expectedVttPath = path.join(outputDir, `${videoId}.en.vtt`);

  // Ensure temp directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`  Attempting to fetch subtitles for video: ${videoId}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const ytdlp = spawn('docker', [
        'run',
        '--rm',
        '-v', `${outputDir}:/downloads`,
        'jauderho/yt-dlp:latest',
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'vtt',
        '--skip-download',
        '-o', `/downloads/${videoId}.%(ext)s`,
        `https://www.youtube.com/watch?v=${videoId}`
      ]);

      let errorOutput = '';

      ytdlp.stdout.on('data', (data) => {
        process.stdout.write(data.toString());
      });

      ytdlp.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp subtitle download exited with code ${code}: ${errorOutput}`));
        }
      });

      ytdlp.on('error', (err) => {
        reject(new Error(`Failed to spawn yt-dlp for subtitles: ${err.message}`));
      });
    });

    // Check if subtitle file was actually created
    if (fs.existsSync(expectedVttPath)) {
      const fileSize = fs.statSync(expectedVttPath).size;
      console.log(`  ✓ Subtitles downloaded: ${expectedVttPath} (${(fileSize / 1024).toFixed(1)} KB)`);
      return { success: true, vttPath: expectedVttPath };
    }

    console.log(`  ⚠ yt-dlp succeeded but no English subtitle file found`);
    return { success: false, vttPath: '' };
  } catch (error: any) {
    console.log(`  ⚠ Subtitle download failed: ${error.message}`);
    return { success: false, vttPath: '' };
  }
}
