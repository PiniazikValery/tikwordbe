import fs from 'fs';
import path from 'path';
import { CaptionSegment } from './sentenceDetector';

function parseVTT(vttContent: string): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const lines = vttContent.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line (e.g., "00:00:00.000 --> 00:00:03.000")
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim());

      // Parse timestamp (HH:MM:SS.mmm or MM:SS.mmm)
      const parseTimestamp = (ts: string): number => {
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
      };

      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);

      // Get caption text (next non-empty line)
      i++;
      let text = '';
      while (i < lines.length && lines[i].trim() !== '') {
        text += (text ? ' ' : '') + lines[i].trim();
        i++;
      }

      if (text) {
        segments.push({
          text: text,
          start: start,
          duration: end - start
        });
      }
    }

    i++;
  }

  return segments;
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

