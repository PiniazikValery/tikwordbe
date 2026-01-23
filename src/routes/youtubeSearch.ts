import { Router, Request, Response } from 'express';
import { normalizeQuery } from '../utils/normalize';
import { generateHash } from '../utils/hash';
import { findByHash } from '../db/videoExamples';
import {
  findJobByHash,
  findJobById,
  createJob,
  JobStatus,
} from '../db/jobQueue';

const router = Router();

interface SearchRequest {
  query: string;
  jobId?: string; // Optional: for polling a specific job by ID
}

interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

// Response when job is completed
interface CompletedResponse {
  status: 'completed';
  jobId: string;
  query: string;
  videoId: string;
  videoUrl: string;
  startTime: number;
  endTime: number;
  caption: string;
  captions: CaptionSegment[];
}

// Response when job is in progress
interface InProgressResponse {
  status: 'queued' | 'searching' | 'downloading' | 'transcribing';
  jobId: string;
  query: string;
  message: string;
  currentVideoId?: string;
}

// Response when job failed
interface FailedResponse {
  status: 'failed';
  jobId: string;
  query: string;
  error: string;
}

type SearchResponse = CompletedResponse | InProgressResponse | FailedResponse;

interface ErrorResponse {
  error: string;
}

router.post('/search', async (req: Request<{}, {}, SearchRequest>, res: Response<SearchResponse | ErrorResponse>) => {
  try {
    const { query, jobId } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
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
          query: job.normalizedQuery,
          ...job.result
        });
      }

      // Job failed
      if (job.status === 'failed') {
        return res.json({
          status: 'failed',
          jobId: job.id,
          query: job.normalizedQuery,
          error: job.error || 'Job processing failed'
        });
      }

      // Job is in progress
      return res.json(getInProgressResponse(
        job.id,
        job.normalizedQuery,
        job.status as JobStatus,
        job.currentVideoId
      ));
    }

    // Step 1: Normalize query
    let normalizedData;
    try {
      normalizedData = normalizeQuery(query);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }

    const { normalized, type } = normalizedData;

    // Step 2: Generate hash for the normalized query
    const hash = generateHash(normalized);

    // Step 3: Check cache for existing completed result
    const cachedResult = await findByHash(hash);

    if (cachedResult) {
      console.log(`✓ Cache hit for query: "${normalized}"`);
      return res.json({
        status: 'completed',
        jobId: hash, // Use hash as identifier for cached results
        query: normalized,
        videoId: cachedResult.videoId,
        videoUrl: `https://www.youtube.com/watch?v=${cachedResult.videoId}`,
        startTime: cachedResult.startTime,
        endTime: cachedResult.endTime,
        caption: cachedResult.caption,
        captions: cachedResult.captions
      });
    }

    // Step 4: Check if job already exists in queue
    const existingJob = await findJobByHash(hash);

    if (existingJob) {
      console.log(`Job exists for query: "${normalized}" with status: ${existingJob.status}`);

      // If job is completed, return the result
      if (existingJob.status === 'completed' && existingJob.result) {
        return res.json({
          status: 'completed',
          jobId: existingJob.id,
          query: existingJob.normalizedQuery,
          ...existingJob.result
        });
      }

      // If job failed, return the error
      if (existingJob.status === 'failed') {
        return res.json({
          status: 'failed',
          jobId: existingJob.id,
          query: existingJob.normalizedQuery,
          error: existingJob.error || 'Job processing failed'
        });
      }

      // Job is in progress, return status
      return res.json(getInProgressResponse(
        existingJob.id,
        existingJob.normalizedQuery,
        existingJob.status as JobStatus,
        existingJob.currentVideoId
      ));
    }

    // Step 5: Create new job
    console.log(`Creating new job for query: "${normalized}" (type: ${type})`);
    const newJob = await createJob({
      hash,
      query,
      normalizedQuery: normalized,
      queryType: type
    });

    // Step 6: Return queued status
    return res.json({
      status: 'queued',
      jobId: newJob.id,
      query: normalized,
      message: 'Your word has been placed in the queue to find a video'
    });

  } catch (error: any) {
    console.error('Error in /youtube/search:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Helper function to generate in-progress response messages
function getInProgressResponse(jobId: string, query: string, status: JobStatus, currentVideoId?: string): InProgressResponse {
  switch (status) {
    case 'queued':
      return {
        status: 'queued',
        jobId,
        query,
        message: 'Your word is queued and waiting to be processed'
      };
    case 'searching':
      return {
        status: 'searching',
        jobId,
        query,
        message: 'Searching for videos that contain your word'
      };
    case 'downloading':
      return {
        status: 'downloading',
        jobId,
        query,
        message: 'Found a video! Downloading audio for transcription',
        currentVideoId
      };
    case 'transcribing':
      return {
        status: 'transcribing',
        jobId,
        query,
        message: 'Transcribing video audio to find your word',
        currentVideoId
      };
    default:
      return {
        status: 'queued',
        jobId,
        query,
        message: 'Processing your request'
      };
  }
}

export default router;
