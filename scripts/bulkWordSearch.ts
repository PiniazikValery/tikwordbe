import { normalizeQuery } from '../src/utils/normalize';
import { generateHash } from '../src/utils/hash';
import { createJob, findJobByHash } from '../src/db/jobQueue';
import { findByHash as findCachedByHash } from '../src/db/videoExamples';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Configuration
const CONFIG = {
  // Rate limiting: process N words per minute
  WORDS_PER_MINUTE: 10,

  // Delay between words in milliseconds
  get DELAY_MS() {
    return (60 * 1000) / this.WORDS_PER_MINUTE;
  },

  // Word list source
  WORD_LIST_URL: 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears-medium.txt',

  // Progress file to track which words have been processed
  PROGRESS_FILE: path.join(process.cwd(), 'scripts', 'bulk-search-progress.json'),

  // Whether to reprocess words that already have results
  REPROCESS_EXISTING: true,
};

interface Progress {
  totalWords: number;
  processedWords: number;
  skippedWords: number;
  failedWords: number;
  lastProcessedWord: string;
  lastProcessedIndex: number;
  startedAt: string;
  lastUpdatedAt: string;
}

// Load progress from file
function loadProgress(): Progress | null {
  try {
    if (fs.existsSync(CONFIG.PROGRESS_FILE)) {
      const data = fs.readFileSync(CONFIG.PROGRESS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error: any) {
    console.error('Error loading progress:', error.message);
  }
  return null;
}

// Save progress to file
function saveProgress(progress: Progress): void {
  try {
    const dir = path.dirname(CONFIG.PROGRESS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (error: any) {
    console.error('Error saving progress:', error.message);
  }
}

// Fetch word list from URL
async function fetchWordList(): Promise<string[]> {
  console.log(`📥 Fetching word list from: ${CONFIG.WORD_LIST_URL}\n`);

  try {
    const response = await axios.get(CONFIG.WORD_LIST_URL);
    const words = response.data
      .split('\n')
      .map((word: string) => word.trim())
      .filter((word: string) => word.length > 0);

    console.log(`✓ Loaded ${words.length} words\n`);
    return words;
  } catch (error: any) {
    console.error('❌ Error fetching word list:', error.message);
    throw error;
  }
}

// Check if word already has results
async function wordHasResults(hash: string): Promise<boolean> {
  // Check cache first
  const cached = await findCachedByHash(hash);
  if (cached) return true;

  // Check if job exists and is completed
  const job = await findJobByHash(hash);
  if (job && job.status === 'completed') return true;

  return false;
}

// Process a single word
async function processWord(word: string, index: number, total: number): Promise<'processed' | 'skipped' | 'failed'> {
  try {
    // Normalize the word
    let normalizedData;
    try {
      normalizedData = normalizeQuery(word);
    } catch (error: any) {
      console.log(`  ⚠️ Skipping invalid word: "${word}" - ${error.message}`);
      return 'skipped';
    }

    const { normalized, type } = normalizedData;
    const hash = generateHash(normalized);

    // Check if word already has results
    if (!CONFIG.REPROCESS_EXISTING) {
      const hasResults = await wordHasResults(hash);
      if (hasResults) {
        console.log(`  ⏭️  [${index + 1}/${total}] Skipping "${normalized}" - already has results`);
        return 'skipped';
      }
    }

    // Check if job already exists
    const existingJob = await findJobByHash(hash);

    if (existingJob) {
      // If reprocessing, we could delete the old job, but for now let's just skip
      // to avoid duplicate jobs in the queue
      if (existingJob.status === 'queued' || existingJob.status === 'searching' ||
          existingJob.status === 'downloading' || existingJob.status === 'transcribing') {
        console.log(`  ⏸️  [${index + 1}/${total}] "${normalized}" - job already in progress (${existingJob.status})`);
        return 'skipped';
      }

      if (CONFIG.REPROCESS_EXISTING && existingJob.status === 'completed') {
        console.log(`  🔄 [${index + 1}/${total}] "${normalized}" - reprocessing completed job`);
        // Note: We're creating a new job even though one exists
        // The background worker will process it again
      }
    }

    // Create job
    const job = await createJob({
      hash,
      query: word,
      normalizedQuery: normalized,
      queryType: type
    });

    console.log(`  ✅ [${index + 1}/${total}] Queued "${normalized}" (Job ID: ${job.id})`);
    return 'processed';

  } catch (error: any) {
    console.error(`  ❌ [${index + 1}/${total}] Error processing "${word}": ${error.message}`);
    return 'failed';
  }
}

// Sleep function for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BULK WORD SEARCH - Pre-populate Database');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Configuration:');
  console.log(`  • Words per minute: ${CONFIG.WORDS_PER_MINUTE}`);
  console.log(`  • Delay between words: ${CONFIG.DELAY_MS}ms`);
  console.log(`  • Reprocess existing: ${CONFIG.REPROCESS_EXISTING ? 'Yes' : 'No'}`);
  console.log(`  • Progress file: ${CONFIG.PROGRESS_FILE}\n`);

  // Load existing progress
  let progress = loadProgress();
  const isResume = progress !== null;

  // Fetch word list
  const allWords = await fetchWordList();

  // Initialize or resume progress
  if (!progress) {
    progress = {
      totalWords: allWords.length,
      processedWords: 0,
      skippedWords: 0,
      failedWords: 0,
      lastProcessedWord: '',
      lastProcessedIndex: -1,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  if (isResume) {
    console.log('📋 Resuming from previous session:');
    console.log(`  • Last processed: "${progress.lastProcessedWord}" (index ${progress.lastProcessedIndex})`);
    console.log(`  • Processed: ${progress.processedWords}`);
    console.log(`  • Skipped: ${progress.skippedWords}`);
    console.log(`  • Failed: ${progress.failedWords}\n`);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Starting processing...');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Start from where we left off
  const startIndex = progress.lastProcessedIndex + 1;

  // Process each word with rate limiting
  for (let i = startIndex; i < allWords.length; i++) {
    const word = allWords[i];

    const result = await processWord(word, i, allWords.length);

    // Update progress
    if (result === 'processed') {
      progress.processedWords++;
    } else if (result === 'skipped') {
      progress.skippedWords++;
    } else if (result === 'failed') {
      progress.failedWords++;
    }

    progress.lastProcessedWord = word;
    progress.lastProcessedIndex = i;
    progress.lastUpdatedAt = new Date().toISOString();

    // Save progress every 10 words
    if ((i + 1) % 10 === 0) {
      saveProgress(progress);
    }

    // Show progress summary every 50 words
    if ((i + 1) % 50 === 0) {
      const percentComplete = ((i + 1) / allWords.length * 100).toFixed(1);
      const remaining = allWords.length - (i + 1);
      const estimatedMinutes = Math.ceil(remaining / CONFIG.WORDS_PER_MINUTE);

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Progress: ${i + 1}/${allWords.length} (${percentComplete}%)`);
      console.log(`  Processed: ${progress.processedWords} | Skipped: ${progress.skippedWords} | Failed: ${progress.failedWords}`);
      console.log(`  Remaining: ${remaining} words (~${estimatedMinutes} minutes)`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }

    // Rate limiting: wait before processing next word
    if (i < allWords.length - 1) {
      await sleep(CONFIG.DELAY_MS);
    }
  }

  // Final save
  saveProgress(progress);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✨ BULK PROCESSING COMPLETE!');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('Final Statistics:');
  console.log(`  • Total words: ${progress.totalWords}`);
  console.log(`  • Processed: ${progress.processedWords}`);
  console.log(`  • Skipped: ${progress.skippedWords}`);
  console.log(`  • Failed: ${progress.failedWords}`);
  console.log(`  • Duration: ${new Date().toISOString()}`);
  console.log(`\n📝 Note: Jobs have been queued. The background worker will process them asynchronously.`);
  console.log(`   Monitor the job queue to see processing status.\n`);

  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⏸️  Received interrupt signal. Saving progress...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n⏸️  Received termination signal. Saving progress...');
  process.exit(0);
});

// Run the script
main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
