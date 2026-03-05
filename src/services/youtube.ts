import axios from 'axios';
import { spawn } from 'child_process';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
}

export interface YouTubeVideoWithStats extends YouTubeVideo {
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
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
 * Compute ad-likelihood score from video signals.
 * 0 = almost certainly no ads, 100 = very likely to have ads.
 */
function computeAdLikelihoodScore(signals: {
  isCreativeCommons: boolean;
  channelFollowerCount?: number;
  duration?: number;
}): number {
  // Creative Commons = cannot monetize, score 0
  if (signals.isCreativeCommons) return 0;

  let score = 0;

  // Subscriber-based scoring (biggest factor)
  const subs = signals.channelFollowerCount;
  if (subs === undefined) {
    score += 30; // Unknown = moderate risk
  } else if (subs < 1000) {
    score += 0;  // Below YPP threshold, cannot monetize
  } else if (subs < 10000) {
    score += 30; // Small monetized channel, may or may not run ads
  } else if (subs < 100000) {
    score += 60; // Medium channel, very likely runs ads
  } else {
    score += 80; // Large channel, almost certainly runs ads
  }

  // Duration-based scoring:
  // Very short videos (< 2 min) rarely have pre-roll ads even on monetized channels.
  // Videos 2–8 min may have pre-roll. Videos > 8 min can also have mid-roll.
  const dur = signals.duration;
  if (dur !== undefined) {
    if (dur < 120) {
      score = Math.max(0, score - 20); // Short videos are less ad-heavy
    } else if (dur > 480) {
      score = Math.min(100, score + 10); // Longer videos may have mid-roll ads too
    }
  }

  return score;
}

/**
 * Search for videos using yt-dlp (no API key required, no quota limits)
 * Falls back to YouTube API if yt-dlp fails and API key is available.
 * When API is available, tries Creative Commons search first for ad-free results.
 */
export async function searchVideosWithAdFilters(
  query: string,
  targetResults: number = 5
): Promise<YouTubeVideo[]> {
  const allVideos: YouTubeVideo[] = [];
  const seenIds = new Set<string>();

  const addUnique = (videos: YouTubeVideo[]) => {
    for (const v of videos) {
      if (!seenIds.has(v.videoId)) {
        seenIds.add(v.videoId);
        allVideos.push(v);
      }
    }
  };

  // Strategy 1: Try Creative Commons search via YouTube API (these videos CANNOT have ads)
  if (YOUTUBE_API_KEY) {
    try {
      console.log(`  Searching YouTube API (Creative Commons): "${query}"`);
      const ccVideos = await searchVideos(query, targetResults, {
        videoLicense: 'creativeCommon',
      });
      if (ccVideos.length > 0) {
        console.log(`  Found ${ccVideos.length} Creative Commons videos`);
        addUnique(ccVideos);
      }
    } catch (error: any) {
      console.log(`  CC search failed: ${error.message}`);
    }
  }

  // If we already have enough CC results, return early
  if (allVideos.length >= targetResults) {
    return allVideos.slice(0, targetResults);
  }

  // Strategy 2: yt-dlp search (no API key needed)
  console.log(`  Searching with yt-dlp: "${query}"`);
  const ytdlpVideos = await searchVideosWithYtdlp(query, targetResults);
  if (ytdlpVideos.length > 0) {
    console.log(`  Found ${ytdlpVideos.length} videos via yt-dlp`);
    addUnique(ytdlpVideos);
  }

  if (allVideos.length >= targetResults) {
    return allVideos.slice(0, targetResults);
  }

  // Strategy 3: Regular YouTube API search (fallback for short videos, less likely to have ads)
  if (YOUTUBE_API_KEY && allVideos.length < targetResults) {
    try {
      console.log(`  Searching YouTube API (short videos): "${query}"`);
      const shortVideos = await searchVideos(query, targetResults, {
        videoDuration: 'short', // < 4 minutes — less likely to have ads
      });
      if (shortVideos.length > 0) {
        console.log(`  Found ${shortVideos.length} short videos via YouTube API`);
        addUnique(shortVideos);
      }
    } catch (error: any) {
      console.log(`  Short video search failed: ${error.message}`);
    }
  }

  if (allVideos.length >= targetResults) {
    return allVideos.slice(0, targetResults);
  }

  // Strategy 4: Regular YouTube API (no filters)
  if (YOUTUBE_API_KEY && allVideos.length < targetResults) {
    try {
      console.log(`  Searching YouTube API (regular): "${query}"`);
      const apiVideos = await searchVideos(query, targetResults);
      if (apiVideos.length > 0) {
        console.log(`  Found ${apiVideos.length} videos via YouTube API`);
        addUnique(apiVideos);
      }
    } catch (error: any) {
      console.log(`  YouTube API fallback failed: ${error.message}`);
    }
  }

  return allVideos;
}

export interface VideoDetails {
  embeddable: boolean;
  channelFollowerCount?: number;
  license?: string;
  duration?: number; // seconds
  isCreativeCommons: boolean;
  /**
   * Whether the video is likely monetized (and thus shows pre-roll ads).
   * CC-licensed videos are never monetized.
   * YouTube Partner Program requires 1,000+ subscribers AND 4,000 watch hours to monetize.
   */
  isLikelyMonetized: boolean;
  /**
   * 0 = almost certainly no ads, higher = more likely to have ads.
   * Combines subscriber count, license, and duration signals.
   */
  adLikelihoodScore: number;
}

/**
 * Get detailed video metadata using yt-dlp (no API key required).
 * Returns embeddability status + monetization signals extracted from yt-dlp JSON.
 */
export async function getVideoDetails(videoId: string): Promise<VideoDetails> {
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
        resolve({ embeddable: false, isCreativeCommons: false, isLikelyMonetized: false, adLikelihoodScore: 50 });
        return;
      }

      try {
        const data = JSON.parse(output);
        // Check if video is playable
        const isAvailable = data.availability === 'public' || data.availability === undefined;
        const notLive = !data.is_live;
        const notAgeRestricted = !data.age_limit || data.age_limit < 18;

        const embeddable = isAvailable && notLive && notAgeRestricted;

        const channelFollowerCount: number | undefined = data.channel_follower_count;
        const license: string | undefined = data.license;
        const duration: number | undefined = data.duration;

        // Creative Commons license means the video cannot be monetized
        const isCreativeCommons = !!(license && license.toLowerCase().includes('creative commons'));

        // YouTube Partner Program requires 1,000+ subscribers AND 4,000 watch hours.
        // CC-licensed videos are never monetized regardless of channel size.
        const isLikelyMonetized =
          !isCreativeCommons &&
          channelFollowerCount !== undefined &&
          channelFollowerCount >= 1000;

        // Compute an ad-likelihood score (0 = best, higher = more ads expected)
        const adLikelihoodScore = computeAdLikelihoodScore({
          isCreativeCommons,
          channelFollowerCount,
          duration,
        });

        resolve({
          embeddable,
          channelFollowerCount,
          license,
          duration,
          isCreativeCommons,
          isLikelyMonetized,
          adLikelihoodScore,
        });
      } catch (parseError: any) {
        console.log(`  Failed to parse video info for ${videoId}`);
        resolve({ embeddable: false, isCreativeCommons: false, isLikelyMonetized: false, adLikelihoodScore: 50 });
      }
    });

    ytdlp.on('error', (err) => {
      console.log(`  yt-dlp error checking ${videoId}: ${err.message}`);
      resolve({ embeddable: false, isCreativeCommons: false, isLikelyMonetized: false, adLikelihoodScore: 50 });
    });
  });
}

/**
 * Check if a video is embeddable using yt-dlp (no API key required).
 * Simple wrapper around getVideoDetails for backward compatibility.
 */
export async function isVideoEmbeddable(videoId: string): Promise<boolean> {
  const details = await getVideoDetails(videoId);
  return details.embeddable;
}

// Categories useful for language learning (speech-heavy, educational content)
const TRENDING_CATEGORY_IDS = [
  '27', // Education
  '28', // Science & Technology
];

/**
 * Fetch trending/most popular videos from YouTube Data API
 * Fetches from multiple speech-heavy categories (News, Education, Science & Tech)
 * Costs 1 quota unit per category per request
 */
export async function fetchTrendingVideos(
  regionCode: string = 'US',
  maxResults: number = 10
): Promise<YouTubeVideoWithStats[]> {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not configured');
  }

  const perCategory = Math.ceil(maxResults / TRENDING_CATEGORY_IDS.length);
  const allVideos: YouTubeVideoWithStats[] = [];
  const seenIds = new Set<string>();

  const categoryNames: Record<string, string> = { '27': 'Education', '28': 'Science & Technology' };

  for (const categoryId of TRENDING_CATEGORY_IDS) {
    try {
      console.log(`[Trending] Fetching category ${categoryId} (${categoryNames[categoryId] || 'Unknown'})...`);
      const response = await axios.get(`${YOUTUBE_API_BASE_URL}/videos`, {
        params: {
          key: YOUTUBE_API_KEY,
          chart: 'mostPopular',
          regionCode,
          videoCategoryId: categoryId,
          part: 'snippet,statistics',
          maxResults: perCategory,
        }
      });

      console.log(`[Trending] Category ${categoryId}: got ${response.data.items?.length || 0} videos`);
      for (const item of response.data.items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        console.log(`[Trending]   + ${item.id} "${item.snippet.title}" (category: ${categoryNames[categoryId]}, views: ${item.statistics.viewCount})`);
        allVideos.push({
          videoId: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          viewCount: parseInt(item.statistics.viewCount || '0'),
          likeCount: parseInt(item.statistics.likeCount || '0'),
          commentCount: parseInt(item.statistics.commentCount || '0'),
          publishedAt: item.snippet.publishedAt,
        });
      }
    } catch (error: any) {
      if (error.response?.status === 403) {
        throw new Error('YouTube API quota exceeded or invalid API key');
      }
      console.error(`[Trending] Failed to fetch category ${categoryId}: ${error.message}`);
    }
  }

  // Sort by view count and return top N
  allVideos.sort((a, b) => b.viewCount - a.viewCount);
  return allVideos.slice(0, maxResults);
}

/**
 * Fetch video statistics from YouTube Data API
 * Costs 1 quota unit per request
 * Returns null if video not found or API fails
 */
export async function fetchVideoStatistics(
  videoId: string
): Promise<{ viewCount: number; likeCount: number; commentCount: number } | null> {
  if (!YOUTUBE_API_KEY) {
    return null;
  }

  try {
    const response = await axios.get(`${YOUTUBE_API_BASE_URL}/videos`, {
      params: {
        key: YOUTUBE_API_KEY,
        id: videoId,
        part: 'statistics',
      }
    });

    if (!response.data.items || response.data.items.length === 0) return null;

    const stats = response.data.items[0].statistics;
    return {
      viewCount: parseInt(stats.viewCount || '0'),
      likeCount: parseInt(stats.likeCount || '0'),
      commentCount: parseInt(stats.commentCount || '0'),
    };
  } catch (error: any) {
    console.error(`Failed to fetch statistics for video ${videoId}: ${error.message}`);
    return null;
  }
}
