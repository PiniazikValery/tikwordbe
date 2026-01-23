import axios from 'axios';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
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
 * Search for videos with multiple filter strategies to minimize ads
 * Tries: 1) Creative Commons, 2) Short videos, 3) Medium videos, 4) Any
 */
export async function searchVideosWithAdFilters(
  query: string,
  targetResults: number = 5
): Promise<YouTubeVideo[]> {
  const strategies: SearchOptions[] = [
    { videoLicense: 'creativeCommon', videoDuration: 'short' }, // CC + short (least ads)
    { videoLicense: 'creativeCommon' }, // CC only
    { videoDuration: 'short' }, // Short videos (< 4 min, fewer ads)
    { videoDuration: 'medium' }, // Medium videos (4-20 min)
    {} // No filters (fallback)
  ];

  let allVideos: YouTubeVideo[] = [];
  const seenIds = new Set<string>();

  for (const options of strategies) {
    const filterDesc = [];
    if (options.videoLicense === 'creativeCommon') filterDesc.push('CC-licensed');
    if (options.videoDuration) filterDesc.push(`${options.videoDuration} duration`);
    const filterLabel = filterDesc.length > 0 ? filterDesc.join(' + ') : 'no filters';

    try {
      const videos = await searchVideos(query, 5, options);

      // Deduplicate
      const newVideos = videos.filter(v => !seenIds.has(v.videoId));
      newVideos.forEach(v => seenIds.add(v.videoId));

      if (newVideos.length > 0) {
        console.log(`  Found ${newVideos.length} unique videos with ${filterLabel}`);
        allVideos = [...allVideos, ...newVideos];
      }

      // Stop if we have enough videos
      if (allVideos.length >= targetResults) {
        break;
      }
    } catch (error: any) {
      // Continue to next strategy if this one fails
      console.log(`  No results with ${filterLabel}, trying next strategy...`);
    }
  }

  return allVideos.slice(0, targetResults);
}

/**
 * Check if a video is embeddable (can be played on external websites)
 */
export async function isVideoEmbeddable(videoId: string): Promise<boolean> {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY is not configured');
  }

  try {
    const response = await axios.get(`${YOUTUBE_API_BASE_URL}/videos`, {
      params: {
        key: YOUTUBE_API_KEY,
        id: videoId,
        part: 'status'
      }
    });

    if (response.data.items && response.data.items.length > 0) {
      const video = response.data.items[0];
      return video.status?.embeddable === true;
    }

    return false;
  } catch (error: any) {
    console.error(`Error checking if video ${videoId} is embeddable:`, error.message);
    // If we can't check, assume it's not embeddable to be safe
    return false;
  }
}
