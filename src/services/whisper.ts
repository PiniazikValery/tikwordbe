import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WhisperResult {
  vttPath: string;
  stoppedEarly?: boolean;
  chunksProcessed?: number;
  wordNotFound?: boolean;
}

// Parse VTT to check for word/phrase match
function parseVTTSimple(vttContent: string): string {
  return vttContent.toLowerCase();
}

// Get word variations for flexible matching
function getWordVariations(word: string): string[] {
  const variations = [word];

  // Common verb endings
  if (word.endsWith('e')) {
    variations.push(word.slice(0, -1) + 'ing');
    variations.push(word + 'd');
  }
  if (word.endsWith('t')) {
    variations.push(word + 'ion');
    variations.push(word + 'ed');
    variations.push(word + 'ing');
  }

  // Remove common suffixes to get stem
  if (word.endsWith('ion')) {
    variations.push(word.slice(0, -3));
    variations.push(word.slice(0, -3) + 'ing');
  }
  if (word.endsWith('ing')) {
    variations.push(word.slice(0, -3));
    variations.push(word.slice(0, -3) + 'ion');
  }
  if (word.endsWith('ed')) {
    variations.push(word.slice(0, -2));
  }

  return [...new Set(variations)];
}

// Check if search term appears in VTT content (handles multi-word phrases with variations)
function containsSearchTerm(vttContent: string, searchTerm: string): boolean {
  const lowerContent = vttContent.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();

  // For multi-word phrases, check if all words appear nearby (with variations)
  const words = lowerSearch.split(/\s+/);

  if (words.length === 1) {
    // Single word - check exact and variations
    const variations = getWordVariations(lowerSearch);
    return variations.some(v => {
      const regex = new RegExp(`\\b${v}\\w*\\b`, 'i');
      return regex.test(lowerContent);
    });
  }

  // Multi-word phrase - check if all words (or their variations) appear within 200 chars
  for (const word of words) {
    const variations = getWordVariations(word);
    const found = variations.some(v => {
      const regex = new RegExp(`\\b${v}\\w*\\b`, 'i');
      return regex.test(lowerContent);
    });

    if (!found) {
      return false; // Word (or any variation) not found
    }
  }

  return true;
}

// Chunk audio into segments using ffmpeg
async function chunkAudio(audioPath: string, chunkDuration: number = 30): Promise<string[]> {
  const outputDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));

  console.log(`  Splitting audio into ${chunkDuration}s chunks...`);

  // Use ffmpeg to split audio into chunks
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('docker', [
      'run',
      '--rm',
      '-v', `${outputDir}:/audio`,
      'jrottenberg/ffmpeg:latest',
      '-i', `/audio/${path.basename(audioPath)}`,
      '-f', 'segment',
      '-segment_time', chunkDuration.toString(),
      '-c', 'copy',
      `/audio/${baseName}_chunk_%03d.mp3`
    ]);

    let errorOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${errorOutput}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });

  // Find all chunk files
  const files = fs.readdirSync(outputDir);
  const chunks = files
    .filter(f => f.startsWith(`${baseName}_chunk_`) && f.endsWith('.mp3'))
    .sort()
    .map(f => path.join(outputDir, f));

  console.log(`  Created ${chunks.length} chunks`);
  return chunks;
}

// Transcribe a single chunk
async function transcribeChunk(chunkPath: string, chunkIndex: number, useGPU: boolean = false): Promise<string> {
  const outputDir = path.dirname(chunkPath);
  const baseName = path.basename(chunkPath, '.mp3');
  const vttPath = path.join(outputDir, `${baseName}.vtt`);

  console.log(`  Transcribing chunk ${chunkIndex + 1}${useGPU ? ' (GPU)' : ' (CPU)'}...`);

  // Build docker run arguments
  const dockerArgs = ['run', '--rm'];

  // Add GPU support if requested
  if (useGPU) {
    dockerArgs.push('--gpus', 'all');
  }

  dockerArgs.push(
    '-v', `${outputDir}:/audio`,
    useGPU ? 'tickword-whisper-gpu:latest' : 'tickword-whisper:latest',
    `/audio/${path.basename(chunkPath)}`,
    '--model', 'base',
    '--output_format', 'vtt',
    '--output_dir', '/audio'
  );

  await new Promise<void>((resolve, reject) => {
    const whisper = spawn('docker', dockerArgs);

    let output = '';
    let errorOutput = '';

    whisper.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    whisper.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(text);
    });

    whisper.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Whisper exited with code ${code}: ${errorOutput}`));
      }
    });

    whisper.on('error', (err) => {
      reject(new Error(`Failed to spawn Whisper: ${err.message}`));
    });
  });

  if (!fs.existsSync(vttPath)) {
    throw new Error(`VTT file not found after transcription: ${vttPath}`);
  }

  return vttPath;
}

// Combine multiple VTT files with time offset
function combineVTTs(vttPaths: string[], chunkDuration: number, outputPath: string): void {
  let combinedContent = 'WEBVTT\n\n';

  vttPaths.forEach((vttPath, index) => {
    const timeOffset = index * chunkDuration;
    const content = fs.readFileSync(vttPath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip WEBVTT header
      if (line.startsWith('WEBVTT') || line.startsWith('NOTE')) {
        continue;
      }

      // Adjust timestamps
      if (line.includes('-->')) {
        const [start, end] = line.split('-->').map(s => s.trim());
        const adjustedStart = adjustTimestamp(start, timeOffset);
        const adjustedEnd = adjustTimestamp(end, timeOffset);
        combinedContent += `${adjustedStart} --> ${adjustedEnd}\n`;
      } else {
        combinedContent += line + '\n';
      }
    }

    combinedContent += '\n';
  });

  fs.writeFileSync(outputPath, combinedContent, 'utf-8');
}

// Adjust VTT timestamp by adding offset
function adjustTimestamp(timestamp: string, offsetSeconds: number): string {
  const parts = timestamp.split(':');
  let totalSeconds = 0;

  if (parts.length === 3) {
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parseFloat(parts[2]);
    totalSeconds = hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const minutes = parseInt(parts[0]);
    const seconds = parseFloat(parts[1]);
    totalSeconds = minutes * 60 + seconds;
  }

  totalSeconds += offsetSeconds;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(3);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${seconds.padStart(6, '0')}`;
}

// Clean up chunk files
function cleanupChunks(chunkPaths: string[]): void {
  chunkPaths.forEach(chunk => {
    if (fs.existsSync(chunk)) {
      fs.unlinkSync(chunk);
    }
    const vttPath = chunk.replace('.mp3', '.vtt');
    if (fs.existsSync(vttPath)) {
      fs.unlinkSync(vttPath);
    }
  });
}

export async function transcribeAudio(
  audioPath: string,
  videoId: string,
  searchWord: string,
  chunkDuration: number = 30,
  maxChunks: number = 10,
  useGPU: boolean = false
): Promise<WhisperResult> {
  const outputDir = path.dirname(audioPath);
  const finalVttPath = path.join(outputDir, `${videoId}.vtt`);

  try {
    console.log(`  Transcribing audio with chunked early stopping for word: "${searchWord}" ${useGPU ? '(GPU mode)' : '(CPU mode)'}`);

    // Split audio into chunks
    const chunkPaths = await chunkAudio(audioPath, chunkDuration);

    const processedVTTs: string[] = [];
    let foundWord = false;

    // Process chunks sequentially (up to maxChunks)
    const chunksToProcess = Math.min(chunkPaths.length, maxChunks);
    for (let i = 0; i < chunksToProcess; i++) {
      const chunkPath = chunkPaths[i];

      // Transcribe chunk
      const vttPath = await transcribeChunk(chunkPath, i, useGPU);
      processedVTTs.push(vttPath);

      // Check if search term is found in this chunk
      const vttContent = fs.readFileSync(vttPath, 'utf-8');
      if (containsSearchTerm(vttContent, searchWord)) {
        console.log(`  ✓ Search term "${searchWord}" found in chunk ${i + 1}!`);
        foundWord = true;

        // Process one more chunk to ensure we have the complete sentence
        if (i + 1 < chunkPaths.length) {
          console.log(`  Processing one more chunk to ensure complete sentence...`);
          const nextVttPath = await transcribeChunk(chunkPaths[i + 1], i + 1, useGPU);
          processedVTTs.push(nextVttPath);
        }

        break;
      }

      console.log(`  Word not found in chunk ${i + 1}, continuing...`);
    }

    // Check if we hit the chunk limit without finding the word
    if (!foundWord && processedVTTs.length >= maxChunks) {
      console.log(`  ⚠️ Word not found after ${maxChunks} chunks, stopping search...`);
      cleanupChunks(chunkPaths);
      throw new Error(`Word "${searchWord}" not found in first ${maxChunks} chunks (${maxChunks * chunkDuration}s)`);
    }

    // Combine processed VTTs
    combineVTTs(processedVTTs, chunkDuration, finalVttPath);

    // Cleanup chunk files
    cleanupChunks(chunkPaths);

    console.log(`  Transcription completed: ${finalVttPath} (processed ${processedVTTs.length}/${chunkPaths.length} chunks)`);

    return {
      vttPath: finalVttPath,
      stoppedEarly: foundWord && processedVTTs.length < chunkPaths.length,
      chunksProcessed: processedVTTs.length
    };
  } catch (error: any) {
    console.error(`  Error transcribing audio: ${error.message}`);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}
