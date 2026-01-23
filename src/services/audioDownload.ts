import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface AudioDownloadResult {
  filePath: string;
  fileSizeMB: number;
  duration?: string;
  title?: string;
}

export async function downloadAudio(videoId: string): Promise<AudioDownloadResult> {
  const outputDir = path.join(process.cwd(), 'temp');
  const outputPath = path.join(outputDir, `${videoId}.mp3`);

  try {
    // Ensure temp directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`  Downloading audio for video: ${videoId}`);

    // Download audio using yt-dlp via Docker (works without installing yt-dlp)
    await new Promise<void>((resolve, reject) => {
      const ytdlp = spawn('docker', [
        'run',
        '--rm',
        '-v', `${outputDir}:/downloads`,
        'jauderho/yt-dlp:latest',
        '-f', 'bestaudio',
        '-x',
        '--audio-format', 'mp3',
        '-o', `/downloads/${videoId}.%(ext)s`,
        `https://www.youtube.com/watch?v=${videoId}`
      ]);

      let output = '';
      let errorOutput = '';

      ytdlp.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        process.stdout.write(text);
      });

      ytdlp.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        process.stderr.write(text);
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${errorOutput}`));
        }
      });

      ytdlp.on('error', (err) => {
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });
    });

    // Check if file exists
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Audio file not found after download: ${outputPath}`);
    }

    const fileSizeMB = fs.statSync(outputPath).size / 1024 / 1024;
    console.log(`\n  Audio saved to: ${outputPath}`);
    console.log(`  File size: ${fileSizeMB.toFixed(2)} MB`);

    return {
      filePath: outputPath,
      fileSizeMB: parseFloat(fileSizeMB.toFixed(2))
    };
  } catch (error: any) {
    console.error(`\n  Error downloading audio: ${error.message}`);
    throw new Error(`Failed to download audio: ${error.message}`);
  }
}
