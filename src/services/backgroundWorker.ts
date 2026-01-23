import { getQueuedJobs } from '../db/jobQueue';
import { processJob } from './jobProcessor';

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

// Maximum number of concurrent jobs
const MAX_CONCURRENT_JOBS = 5;

// Time to wait between polling cycles (in milliseconds)
const POLL_INTERVAL = 2000; // 2 seconds

// Track currently running jobs
const runningJobs = new Map<string, Promise<void>>();

// Process a single job
async function startJobProcessing(hash: string, normalizedQuery: string, queryType: 'word' | 'sentence'): Promise<void> {
  console.log(`\n[Background Worker] Starting job: "${normalizedQuery}" (type: ${queryType})`);
  console.log(`[Background Worker] Active jobs: ${runningJobs.size}/${MAX_CONCURRENT_JOBS}`);

  try {
    // Process the job (this will update its status as it progresses)
    await processJob(hash, normalizedQuery, queryType);
  } catch (error: any) {
    console.error(`[Background Worker] Error processing job "${normalizedQuery}":`, error.message);
  } finally {
    // Remove from running jobs when complete
    runningJobs.delete(hash);
    console.log(`[Background Worker] Job completed: "${normalizedQuery}"`);
    console.log(`[Background Worker] Active jobs: ${runningJobs.size}/${MAX_CONCURRENT_JOBS}`);

    // Check for more jobs immediately after completion
    setImmediate(() => workerLoop());
  }
}

// Main worker loop - starts new jobs up to the concurrency limit
async function workerLoop(): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    // Check if we can start more jobs
    if (runningJobs.size >= MAX_CONCURRENT_JOBS) {
      // At capacity, wait and check again later
      workerInterval = setTimeout(() => workerLoop(), POLL_INTERVAL);
      return;
    }

    // Get all queued jobs
    const jobs = await getQueuedJobs();

    if (jobs.length === 0) {
      // No jobs in queue, wait and check again later
      workerInterval = setTimeout(() => workerLoop(), POLL_INTERVAL);
      return;
    }

    // Start jobs up to the concurrency limit
    let jobsStarted = 0;
    for (const job of jobs) {
      // Skip if already processing this job
      if (runningJobs.has(job.hash)) {
        continue;
      }

      // Check if we've reached capacity
      if (runningJobs.size >= MAX_CONCURRENT_JOBS) {
        break;
      }

      // Start processing this job (don't await - let it run in background)
      const jobPromise = startJobProcessing(job.hash, job.normalizedQuery, job.queryType);
      runningJobs.set(job.hash, jobPromise);
      jobsStarted++;
    }

    if (jobsStarted > 0) {
      // Started new jobs, check immediately for more
      setImmediate(() => workerLoop());
    } else {
      // No new jobs started (all are already running), wait and check again
      workerInterval = setTimeout(() => workerLoop(), POLL_INTERVAL);
    }
  } catch (error: any) {
    console.error('[Background Worker] Error in worker loop:', error.message);
    // Wait before retrying
    workerInterval = setTimeout(() => workerLoop(), POLL_INTERVAL);
  }
}

// Start the background worker
export function startBackgroundWorker(): void {
  if (isRunning) {
    console.log('[Background Worker] Already running');
    return;
  }

  console.log('[Background Worker] Starting...');
  isRunning = true;
  workerLoop();
}

// Stop the background worker
export function stopBackgroundWorker(): void {
  if (!isRunning) {
    console.log('[Background Worker] Not running');
    return;
  }

  console.log('[Background Worker] Stopping...');
  isRunning = false;

  if (workerInterval) {
    clearTimeout(workerInterval);
    workerInterval = null;
  }
}

// Check if worker is running
export function isWorkerRunning(): boolean {
  return isRunning;
}
