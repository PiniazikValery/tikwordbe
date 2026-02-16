import { Router, Request, Response } from 'express';
import { generateHash } from '../utils/hash';
import {
  findJobByHash,
  findJobById,
  createJob,
  deleteJob,
  JobStatus,
} from '../db/jobQueue';

const router = Router();

interface IndexVideoRequest {
  videoUrl: string;
  jobId?: string; // Optional: for polling a specific job by ID
}

// Response when job is completed
interface CompletedResponse {
  status: 'completed';
  jobId: string;
  videoId: string;
  videoUrl: string;
  segmentsIndexed: number;
  wordsIndexed: number;
}

// Response when job is in progress
interface InProgressResponse {
  status: 'queued' | 'downloading' | 'transcribing' | 'indexing';
  jobId: string;
  videoId: string;
  message: string;
}

// Response when job failed
interface FailedResponse {
  status: 'failed';
  jobId: string;
  videoId: string;
  error: string;
}

type IndexVideoResponse = CompletedResponse | InProgressResponse | FailedResponse;

interface ErrorResponse {
  error: string;
}

/**
 * Extract video ID from various YouTube URL formats
 */
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // Just the video ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

router.post('/index', async (req: Request<{}, {}, IndexVideoRequest>, res: Response<IndexVideoResponse | ErrorResponse>) => {
  try {
    const { videoUrl, jobId } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }

    // Extract video ID from URL
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube video URL' });
    }

    // If jobId is provided, this is a polling request for a specific job
    if (jobId) {
      const job = await findJobById(jobId);

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      // Job is completed
      if (job.status === 'completed' && job.result) {
        return res.json({
          status: 'completed',
          jobId: job.id,
          videoId: job.result.videoId,
          videoUrl: job.result.videoUrl,
          segmentsIndexed: job.result.segmentsIndexed || 0,
          wordsIndexed: job.result.wordsIndexed || 0
        });
      }

      // Job failed
      if (job.status === 'failed') {
        return res.json({
          status: 'failed',
          jobId: job.id,
          videoId,
          error: job.error || 'Job processing failed'
        });
      }

      // Job is in progress
      return res.json(getInProgressResponse(job.id, videoId, job.status as JobStatus));
    }

    // Generate hash using video ID as the query (prefixed to avoid collision with word searches)
    const hash = generateHash(`video-index:${videoId}`);

    // Check if job already exists in queue
    const existingJob = await findJobByHash(hash);

    if (existingJob) {
      console.log(`Video index job exists for: ${videoId} with status: ${existingJob.status}`);

      // If job is completed, return the result
      if (existingJob.status === 'completed' && existingJob.result) {
        return res.json({
          status: 'completed',
          jobId: existingJob.id,
          videoId: existingJob.result.videoId,
          videoUrl: existingJob.result.videoUrl,
          segmentsIndexed: existingJob.result.segmentsIndexed || 0,
          wordsIndexed: existingJob.result.wordsIndexed || 0
        });
      }

      // If job failed, delete it and allow immediate retry
      if (existingJob.status === 'failed') {
        console.log(`Deleting failed video index job for: ${videoId}, allowing retry...`);
        await deleteJob(existingJob.id);
        // Fall through to create new job below
      } else {
        // Job is in progress, return status
        return res.json(getInProgressResponse(existingJob.id, videoId, existingJob.status as JobStatus));
      }
    }

    // Create new job with special query type 'video-index'
    console.log(`Creating new video index job for: ${videoId}`);
    const newJob = await createJob({
      hash,
      query: videoUrl,
      normalizedQuery: videoId, // Store video ID as normalized query
      queryType: 'video-index' as any // Special type for video indexing
    });

    // Return queued status
    return res.json({
      status: 'queued',
      jobId: newJob.id,
      videoId,
      message: 'Video has been queued for indexing'
    });

  } catch (error: any) {
    console.error('Error in /video-index/index:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Helper function to generate in-progress response messages
function getInProgressResponse(jobId: string, videoId: string, status: JobStatus): InProgressResponse {
  switch (status) {
    case 'queued':
      return {
        status: 'queued',
        jobId,
        videoId,
        message: 'Video is queued and waiting to be processed'
      };
    case 'downloading':
      return {
        status: 'downloading',
        jobId,
        videoId,
        message: 'Downloading video audio for transcription'
      };
    case 'transcribing':
      return {
        status: 'transcribing',
        jobId,
        videoId,
        message: 'Transcribing video audio'
      };
    case 'searching':
      // Map 'searching' status to 'indexing' for video indexing
      return {
        status: 'indexing',
        jobId,
        videoId,
        message: 'Indexing video segments'
      };
    default:
      return {
        status: 'queued',
        jobId,
        videoId,
        message: 'Processing your request'
      };
  }
}

export default router;
