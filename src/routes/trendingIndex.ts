import { Router, Request, Response } from 'express';
import { fetchTrendingVideos } from '../services/youtube';
import { buildPopularityScore } from '../utils/popularity';
import { isVideoIndexed } from '../db/indexedVideos';
import { findJobByHash, createJob } from '../db/jobQueue';

const router = Router();

router.post('/discover', async (req: Request, res: Response) => {
  try {
    const regionCode = req.body.regionCode || 'US';
    const maxVideos = Math.min(req.body.maxVideos || 10, 50);

    console.log(`\n[Trending] Discovering ${maxVideos} trending videos (region: ${regionCode})`);

    const trendingVideos = await fetchTrendingVideos(regionCode, maxVideos);
    console.log(`[Trending] Found ${trendingVideos.length} trending videos`);

    let queued = 0;
    let skipped = 0;
    const jobs: Array<{
      jobId: string;
      videoId: string;
      title: string;
      popularityScore: number;
      status: 'queued' | 'already_indexed' | 'already_queued';
    }> = [];

    for (const video of trendingVideos) {
      // Check if already indexed
      const alreadyIndexed = await isVideoIndexed(video.videoId);
      if (alreadyIndexed) {
        skipped++;
        jobs.push({
          jobId: '',
          videoId: video.videoId,
          title: video.title,
          popularityScore: 0,
          status: 'already_indexed',
        });
        continue;
      }

      // Check if already in job queue
      const hash = `video-index:${video.videoId}`;
      const existingJob = await findJobByHash(hash);
      if (existingJob) {
        skipped++;
        jobs.push({
          jobId: existingJob.id,
          videoId: video.videoId,
          title: video.title,
          popularityScore: 0,
          status: 'already_queued',
        });
        continue;
      }

      // Calculate popularity
      const popularity = buildPopularityScore({
        viewCount: video.viewCount,
        likeCount: video.likeCount,
        commentCount: video.commentCount,
      });

      // Create job
      const job = await createJob({
        hash,
        query: video.title,
        normalizedQuery: video.videoId,
        queryType: 'video-index',
        metadata: {
          popularity,
          maxChunks: 30, // ~15 minutes cap for trending videos
        },
      });

      queued++;
      jobs.push({
        jobId: job.id,
        videoId: video.videoId,
        title: video.title,
        popularityScore: popularity.score,
        status: 'queued',
      });

      console.log(`[Trending] Queued: ${video.title} (score: ${popularity.score})`);
    }

    console.log(`[Trending] Summary: discovered=${trendingVideos.length}, queued=${queued}, skipped=${skipped}`);

    return res.json({
      discovered: trendingVideos.length,
      queued,
      skipped,
      jobs,
    });
  } catch (error: any) {
    console.error('[Trending] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default router;
