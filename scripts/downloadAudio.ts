import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function downloadAudio(videoId: string) {
  const outputDir = path.join(process.cwd(), 'temp');
  const outputPath = path.join(outputDir, `${videoId}.mp3`);

  try {
    // Ensure temp directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`Downloading audio for video: ${videoId}`);
    console.log(`URL: https://www.youtube.com/watch?v=${videoId}`);

    // Get video info first
    const info = await ytdl.getInfo(videoId);
    console.log(`Title: ${info.videoDetails.title}`);
    console.log(`Duration: ${info.videoDetails.lengthSeconds}s`);

    // Download audio
    const audioStream = ytdl(videoId, {
      quality: 'lowestaudio',
      filter: 'audioonly',
    });

    const writeStream = fs.createWriteStream(outputPath);

    audioStream.pipe(writeStream);

    // Track progress
    let downloadedBytes = 0;
    audioStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const mb = (downloadedBytes / 1024 / 1024).toFixed(2);
      process.stdout.write(`\rDownloaded: ${mb} MB`);
    });

    // Wait for download to complete
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      audioStream.on('error', reject);
    });

    console.log(`\n✓ Audio saved to: ${outputPath}`);
    console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

    return outputPath;
  } catch (error: any) {
    console.error(`\n✗ Error downloading audio: ${error.message}`);
    throw error;
  }
}

// Main execution
const videoId = process.argv[2];

if (!videoId) {
  console.log('Usage: ts-node scripts/downloadAudio.ts <videoId>');
  console.log('Example: ts-node scripts/downloadAudio.ts dQw4w9WgXcQ');
  process.exit(1);
}

downloadAudio(videoId)
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
  });
