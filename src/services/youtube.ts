import axios from 'axios';
import { spawn } from 'child_process';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
}

/**
 * Search YouTube using yt-dlp (no API key required)
 * Uses the ytsearch: prefix to search YouTube directly
 */
export async function searchVideosWithYtdlp(
  query: string,
  maxResults: number = 5
): Promise<YouTubeVideo[]> {
  return new Promise((resolve, reject) => {
    const searchQuery = `ytsearch${maxResults}:${query}`;

    const ytdlp = spawn('docker', [
      'run',
      '--rm',
      'jauderho/yt-dlp:latest',
      searchQuery,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings'
    ]);

    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.error(`yt-dlp search error: ${errorOutput}`);
        resolve([]); // Return empty array on error instead of rejecting
        return;
      }

      try {
        // Each line is a separate JSON object
        const videos: YouTubeVideo[] = output
          .trim()
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            const data = JSON.parse(line);
            return {
              videoId: data.id,
              title: data.title || '',
              description: data.description || ''
            };
          })
          .filter(v => v.videoId); // Filter out any without videoId

        resolve(videos);
      } catch (parseError: any) {
        console.error(`Failed to parse yt-dlp output: ${parseError.message}`);
        resolve([]);
      }
    });

    ytdlp.on('error', (err) => {
      console.error(`Failed to spawn yt-dlp: ${err.message}`);
      resolve([]);
    });
  });
}

export interface SearchOptions {
  videoLicense?: 'creativeCommon' | 'youtube';
  videoDuration?: 'short' | 'medium' | 'long' | 'any';
}

export async function searchVideos(
  query: string,
  maxResults: number = 5,
  options?: SearchOptions
): Promise<YouTubeVideo[]> {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not configured');
  }

  try {
    const params: any = {
      key: YOUTUBE_API_KEY,
      q: query,
      type: 'video',
      part: 'snippet',
      maxResults,
      relevanceLanguage: 'en',
      videoCaption: 'any', // Accept any captions (including auto-generated)
      videoEmbeddable: 'true' // Only return videos that can be embedded
    };

    // Add optional filters to reduce ads
    if (options?.videoLicense) {
      params.videoLicense = options.videoLicense;
    }
    if (options?.videoDuration) {
      params.videoDuration = options.videoDuration;
    }

    const response = await axios.get(`${YOUTUBE_API_BASE_URL}/search`, {
      params
    });

    const videos: YouTubeVideo[] = response.data.items.map((item: any) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description
    }));

    return videos;
  } catch (error: any) {
    if (error.response?.status === 403) {
      throw new Error('YouTube API quota exceeded or invalid API key');
    }
    throw new Error(`YouTube API error: ${error.message}`);
  }
}

/**
 * Search for videos using yt-dlp (no API key required, no quota limits)
 * Falls back to YouTube API if yt-dlp fails and API key is available
 */
export async function searchVideosWithAdFilters(
  query: string,
  targetResults: number = 5
): Promise<YouTubeVideo[]> {
  console.log(`  Searching with yt-dlp: "${query}"`);

  // Try yt-dlp first (no API key needed)
  const videos = await searchVideosWithYtdlp(query, targetResults);

  if (videos.length > 0) {
    console.log(`  Found ${videos.length} videos via yt-dlp`);
    return videos;
  }

  // Fallback to API if yt-dlp returns nothing and API key is available
  if (YOUTUBE_API_KEY) {
    console.log(`  yt-dlp returned no results, trying YouTube API...`);
    try {
      const apiVideos = await searchVideos(query, targetResults);
      if (apiVideos.length > 0) {
        console.log(`  Found ${apiVideos.length} videos via YouTube API`);
        return apiVideos;
      }
    } catch (error: any) {
      console.log(`  YouTube API fallback failed: ${error.message}`);
    }
  }

  return [];
}

/**
 * Check if a video is embeddable using yt-dlp (no API key required)
 */
export async function isVideoEmbeddable(videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const ytdlp = spawn('docker', [
      'run',
      '--rm',
      'jauderho/yt-dlp:latest',
      videoUrl,
      '--dump-json',
      '--no-download',
      '--no-warnings'
    ]);

    let output = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.log(`  Video ${videoId} not available: ${errorOutput.slice(0, 100)}`);
        resolve(false);
        return;
      }

      try {
        const data = JSON.parse(output);
        // Check if video is playable
        const isAvailable = data.availability === 'public' || data.availability === undefined;
        const notLive = !data.is_live;
        const notAgeRestricted = !data.age_limit || data.age_limit < 18;

        const embeddable = isAvailable && notLive && notAgeRestricted;
        resolve(embeddable);
      } catch (parseError: any) {
        console.log(`  Failed to parse video info for ${videoId}`);
        resolve(false);
      }
    });

    ytdlp.on('error', (err) => {
      console.log(`  yt-dlp error checking ${videoId}: ${err.message}`);
      resolve(false);
    });
  });
}
