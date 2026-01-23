import dotenv from 'dotenv';

// Load environment variables FIRST, before other imports
dotenv.config();

import express from 'express';
import cors from 'cors';
import youtubeSearchRouter from './routes/youtubeSearch';
import analyzeSentenceRouter from './routes/analyzeSentence';
import analyzeStreamRouter from './routes/analyzeStream';
import wordIndexRouter from './routes/wordIndex';
import testSearchRouter from './routes/testSearch';
import { initializeDatabase } from './db/videoExamples';
import { initializeJobQueue } from './db/jobQueue';
import { initializeSentenceAnalysisDB } from './db/sentenceAnalyses';
import { initializeRateLimitDB } from './db/rateLimits';
import { initializeAiPaywallDB } from './db/aiPaywall';
import { initializeWordIndexTable } from './db/wordIndex';
import { startBackgroundWorker, stopBackgroundWorker } from './services/backgroundWorker';

// Debug: Check if env vars are loaded
console.log('Environment check:');
console.log('- YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? 'SET' : 'NOT SET');
console.log('- ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
console.log('- DB_NAME:', process.env.DB_NAME);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/youtube', youtubeSearchRouter);
app.use('/api', analyzeStreamRouter);
app.use('/api', analyzeSentenceRouter);
app.use('/word-index', wordIndexRouter);
app.use('/test', testSearchRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
async function startServer() {
  try {
    console.log('Initializing database...');
    await initializeDatabase();
    console.log('Database initialized successfully');

    console.log('Initializing job queue...');
    await initializeJobQueue();
    console.log('Job queue initialized successfully');

    console.log('Initializing sentence analysis database...');
    await initializeSentenceAnalysisDB();
    console.log('Sentence analysis database initialized successfully');

    console.log('Initializing rate limit database...');
    await initializeRateLimitDB();
    console.log('Rate limit database initialized successfully');

    console.log('Initializing AI paywall database...');
    await initializeAiPaywallDB();
    console.log('AI paywall database initialized successfully');

    console.log('Initializing word index...');
    await initializeWordIndexTable();
    console.log('Word index initialized successfully');

    console.log('Starting background worker...');
    startBackgroundWorker();
    console.log('Background worker started successfully');

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`YouTube search: POST http://localhost:${PORT}/youtube/search`);
      console.log(`Analyze sentence: POST http://localhost:${PORT}/api/analyze`);
      console.log(`Analyze sentence (streaming): POST http://localhost:${PORT}/api/analyze/stream`);
      console.log(`Word examples: GET http://localhost:${PORT}/word-index/examples/:word`);
      console.log(`Word index (detailed): GET http://localhost:${PORT}/word-index/word/:word`);
      console.log(`Word stats: GET http://localhost:${PORT}/word-index/stats`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  stopBackgroundWorker();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  stopBackgroundWorker();
  process.exit(0);
});

startServer();
