import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { analyzeSentenceWithClaudeStream } from './claude';
import { ChunkMetadata } from '../db/sentenceAnalyses';

export interface StreamSubscriber {
  id: string;
  res: Response;
  joinedAt: number;
  isReplaying: boolean; // Track if subscriber is currently in replay mode
}

export interface StreamParams {
  sentence: string;
  targetWord: string;
  targetLanguage: string;
  nativeLanguage: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface ActiveStream {
  cacheKey: string;
  params: StreamParams;
  subscribers: Map<string, StreamSubscriber>;
  chunks: ChunkMetadata[];
  fullResponse: string;
  status: 'active' | 'completed' | 'error';
  error?: string;
  createdAt: number;
  apiCallPromise?: Promise<void>;
}

class StreamManager {
  private streams: Map<string, ActiveStream> = new Map();
  private readonly CLEANUP_DELAY = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_ACTIVE_STREAMS = 100;

  /**
   * Helper method to create a delay promise
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if a subscriber is still connected
   */
  private isSubscriberConnected(cacheKey: string, subscriberId: string): boolean {
    const stream = this.streams.get(cacheKey);
    if (!stream) return false;
    
    const subscriber = stream.subscribers.get(subscriberId);
    if (!subscriber) return false;
    
    // Check if the response is still writable
    return !subscriber.res.writableEnded && !subscriber.res.writableFinished;
  }

  /**
   * Replay accumulated chunks to a late-joining subscriber with realistic delays
   * This creates a smooth streaming experience instead of dumping all chunks at once
   * 
   * This method continues replaying until it catches up with all chunks,
   * including any that arrived during the replay process.
   */
  private async replayChunksWithDelay(
    cacheKey: string,
    subscriberId: string,
    startIndex: number = 0
  ): Promise<void> {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      console.log(`Replay cancelled: stream ${cacheKey} no longer exists`);
      return;
    }

    const subscriber = stream.subscribers.get(subscriberId);
    if (!subscriber) {
      console.log(`Replay cancelled: subscriber ${subscriberId} no longer exists`);
      return;
    }

    let currentIndex = startIndex;
    console.log(`✓ Starting chunk replay for subscriber ${subscriberId} from index ${startIndex}`);

    // Keep replaying until we've caught up with all chunks
    while (true) {
      // Get current chunk count (may grow as new chunks arrive)
      const totalChunks = stream.chunks.length;
      
      // Process all chunks from currentIndex to totalChunks
      while (currentIndex < totalChunks) {
        // Safety check: verify subscriber is still connected before each chunk
        if (!this.isSubscriberConnected(cacheKey, subscriberId)) {
          console.log(`Replay stopped: subscriber ${subscriberId} disconnected at chunk ${currentIndex + 1}`);
          return;
        }

        const chunk = stream.chunks[currentIndex];

        try {
          subscriber.res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
        } catch (error) {
          console.error(`Failed to send replay chunk ${currentIndex + 1} to subscriber ${subscriberId}:`, error);
          this.unsubscribe(cacheKey, subscriberId);
          return;
        }

        // Calculate delay before next chunk (same logic as cache replay)
        // Use timestamp differences to simulate realistic timing
        if (currentIndex < stream.chunks.length - 1) {
          const nextChunk = stream.chunks[currentIndex + 1];
          const timeDiff = nextChunk.timestamp - chunk.timestamp;
          // Compress the timing: divide by 3, clamp between 5ms and 30ms
          const delayMs = Math.min(Math.max(Math.floor(timeDiff / 3), 5), 30);
          await this.delay(delayMs);
        }

        currentIndex++;
      }

      // Check if more chunks arrived during our replay
      if (currentIndex >= stream.chunks.length) {
        // We've caught up! Check if stream is done
        if (stream.status === 'completed' || stream.status === 'error') {
          // Stream is finished, we can exit replay mode
          break;
        }
        
        // Stream is still active - wait a bit and check for new chunks
        await this.delay(10);
        
        // If still no new chunks and stream is still active, exit replay mode
        // so we can receive live chunks via publishChunk()
        if (currentIndex >= stream.chunks.length && stream.status === 'active') {
          break;
        }
      }
    }

    // Mark replay as complete - now subscriber can receive live chunks
    const updatedSubscriber = stream.subscribers.get(subscriberId);
    if (updatedSubscriber) {
      updatedSubscriber.isReplaying = false;
      console.log(`✓ Chunk replay completed for subscriber ${subscriberId}. Sent ${currentIndex} chunks total.`);
    }

    // Handle stream completion/error that occurred during replay
    if (stream.status === 'completed') {
      this.sendCompletionToSubscriber(cacheKey, subscriberId);
    } else if (stream.status === 'error') {
      this.sendErrorToSubscriber(cacheKey, subscriberId, stream.error || 'Unknown error');
    }
  }

  /**
   * Send completion message to a specific subscriber
   */
  private sendCompletionToSubscriber(cacheKey: string, subscriberId: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) return;

    const subscriber = stream.subscribers.get(subscriberId);
    if (!subscriber || subscriber.isReplaying) return;

    try {
      subscriber.res.write(`data: ${JSON.stringify({ done: true, fullResponse: stream.fullResponse })}\n\n`);
      subscriber.res.end();
    } catch (error) {
      console.error(`Failed to send completion to subscriber ${subscriberId}:`, error);
    }
  }

  /**
   * Send error message to a specific subscriber
   */
  private sendErrorToSubscriber(cacheKey: string, subscriberId: string, error: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) return;

    const subscriber = stream.subscribers.get(subscriberId);
    if (!subscriber || subscriber.isReplaying) return;

    const errorMessage = error.includes('Claude API')
      ? 'AI service temporarily unavailable. Please try again later.'
      : error.includes('API key')
      ? 'Service configuration error. Please contact support.'
      : 'An error occurred while analyzing the sentence';

    try {
      subscriber.res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      subscriber.res.end();
    } catch (sendError) {
      console.error(`Failed to send error to subscriber ${subscriberId}:`, sendError);
    }
  }

  getStream(cacheKey: string): ActiveStream | undefined {
    return this.streams.get(cacheKey);
  }

  hasActiveStream(cacheKey: string): boolean {
    const stream = this.streams.get(cacheKey);
    return stream !== undefined && stream.status === 'active';
  }

  createStream(cacheKey: string, params: StreamParams): ActiveStream {
    // Check if we've hit the maximum number of active streams
    if (this.streams.size >= this.MAX_ACTIVE_STREAMS) {
      console.warn(`Maximum active streams (${this.MAX_ACTIVE_STREAMS}) reached. Cleaning up oldest completed streams.`);
      this.cleanupOldestCompletedStreams();
    }

    const stream: ActiveStream = {
      cacheKey,
      params,
      subscribers: new Map(),
      chunks: [],
      fullResponse: '',
      status: 'active',
      createdAt: Date.now()
    };

    this.streams.set(cacheKey, stream);
    console.log(`✓ Created new stream: ${cacheKey}`);

    return stream;
  }

  subscribe(cacheKey: string, res: Response): string {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      throw new Error(`Stream not found: ${cacheKey}`);
    }

    const subscriberId = uuidv4();
    const hasAccumulatedChunks = stream.chunks.length > 0;
    
    const subscriber: StreamSubscriber = {
      id: subscriberId,
      res,
      joinedAt: Date.now(),
      isReplaying: hasAccumulatedChunks // Start in replay mode if there are accumulated chunks
    };

    stream.subscribers.set(subscriberId, subscriber);
    console.log(`✓ Subscriber ${subscriberId} joined stream ${cacheKey}. Total subscribers: ${stream.subscribers.size}`);

    // Set up disconnect handler
    res.on('close', () => {
      this.unsubscribe(cacheKey, subscriberId);
    });

    // Handle accumulated chunks with replay (async, with delays)
    if (hasAccumulatedChunks) {
      console.log(`✓ Starting delayed replay of ${stream.chunks.length} accumulated chunks for subscriber ${subscriberId}`);
      
      // Start async replay from index 0 - don't await, let it run in background
      // The replay will continue until it catches up with all chunks (including new ones)
      this.replayChunksWithDelay(cacheKey, subscriberId, 0).catch(error => {
        console.error(`Error during chunk replay for subscriber ${subscriberId}:`, error);
        this.unsubscribe(cacheKey, subscriberId);
      });
    } else if (stream.status === 'completed') {
      // Stream already completed with no chunks (edge case)
      this.sendCompletionToSubscriber(cacheKey, subscriberId);
    } else if (stream.status === 'error') {
      // Stream already errored with no chunks (edge case)
      this.sendErrorToSubscriber(cacheKey, subscriberId, stream.error || 'Unknown error');
    }

    return subscriberId;
  }

  unsubscribe(cacheKey: string, subscriberId: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      return;
    }

    stream.subscribers.delete(subscriberId);
    console.log(`✓ Subscriber ${subscriberId} left stream ${cacheKey}. Remaining subscribers: ${stream.subscribers.size}`);

    // If no subscribers and stream is still active, we could optionally cancel the API call
    // For now, we'll let it complete to save the result to cache
  }

  publishChunk(cacheKey: string, chunk: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      console.error(`Cannot publish chunk: stream not found ${cacheKey}`);
      return;
    }

    // Store chunk with timestamp
    const chunkMetadata: ChunkMetadata = {
      text: chunk,
      timestamp: Date.now() - stream.createdAt
    };
    stream.chunks.push(chunkMetadata);
    stream.fullResponse += chunk;

    // Broadcast to all subscribers (skip those in replay mode - they'll get chunks via replay)
    const deadSubscribers: string[] = [];
    for (const [subscriberId, subscriber] of stream.subscribers) {
      // Skip subscribers that are still replaying - they'll receive this chunk
      // via the replay mechanism or catch up after replay completes
      if (subscriber.isReplaying) {
        continue;
      }

      try {
        subscriber.res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      } catch (error) {
        console.error(`Failed to send chunk to subscriber ${subscriberId}:`, error);
        deadSubscribers.push(subscriberId);
      }
    }

    // Clean up dead subscribers
    for (const subscriberId of deadSubscribers) {
      this.unsubscribe(cacheKey, subscriberId);
    }
  }

  completeStream(cacheKey: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      console.error(`Cannot complete stream: stream not found ${cacheKey}`);
      return;
    }

    stream.status = 'completed';
    console.log(`✓ Stream completed: ${cacheKey}. Total chunks: ${stream.chunks.length}, Total subscribers: ${stream.subscribers.size}`);

    // Send completion message to all subscribers (skip those in replay mode)
    const deadSubscribers: string[] = [];
    for (const [subscriberId, subscriber] of stream.subscribers) {
      // Skip subscribers that are still replaying - they'll get completion after replay
      if (subscriber.isReplaying) {
        console.log(`✓ Subscriber ${subscriberId} is replaying, will send completion after replay`);
        continue;
      }

      try {
        subscriber.res.write(`data: ${JSON.stringify({ done: true, fullResponse: stream.fullResponse })}\n\n`);
        subscriber.res.end();
      } catch (error) {
        console.error(`Failed to send completion to subscriber ${subscriberId}:`, error);
        deadSubscribers.push(subscriberId);
      }
    }

    // Clean up dead subscribers
    for (const subscriberId of deadSubscribers) {
      stream.subscribers.delete(subscriberId);
    }

    // Schedule cleanup after delay
    this.scheduleCleanup(cacheKey);
  }

  errorStream(cacheKey: string, error: string): void {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      console.error(`Cannot error stream: stream not found ${cacheKey}`);
      return;
    }

    stream.status = 'error';
    stream.error = error;
    console.log(`✗ Stream errored: ${cacheKey}. Error: ${error}`);

    // Send error to all subscribers (skip those in replay mode)
    const errorMessage = error.includes('Claude API')
      ? 'AI service temporarily unavailable. Please try again later.'
      : error.includes('API key')
      ? 'Service configuration error. Please contact support.'
      : 'An error occurred while analyzing the sentence';

    const deadSubscribers: string[] = [];
    for (const [subscriberId, subscriber] of stream.subscribers) {
      // Skip subscribers that are still replaying - they'll get error after replay
      if (subscriber.isReplaying) {
        console.log(`✓ Subscriber ${subscriberId} is replaying, will send error after replay`);
        continue;
      }

      try {
        subscriber.res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        subscriber.res.end();
      } catch (sendError) {
        console.error(`Failed to send error to subscriber ${subscriberId}:`, sendError);
        deadSubscribers.push(subscriberId);
      }
    }

    // Clean up dead subscribers
    for (const subscriberId of deadSubscribers) {
      stream.subscribers.delete(subscriberId);
    }

    // Clean up immediately on error
    setTimeout(() => {
      this.streams.delete(cacheKey);
      console.log(`✓ Cleaned up errored stream: ${cacheKey}`);
    }, 1000);
  }

  async startStream(cacheKey: string, params: StreamParams): Promise<void> {
    const stream = this.streams.get(cacheKey);
    if (!stream) {
      throw new Error(`Stream not found: ${cacheKey}`);
    }

    if (stream.apiCallPromise) {
      // API call already started
      return stream.apiCallPromise;
    }

    // Start the Claude API call
    stream.apiCallPromise = (async () => {
      try {
        console.log(`✓ Starting Claude API call for stream: ${cacheKey}`);

        const fullResponse = await analyzeSentenceWithClaudeStream(
          params.sentence,
          params.targetWord,
          params.targetLanguage,
          params.nativeLanguage,
          (chunk: string) => {
            // Publish each chunk to all subscribers
            this.publishChunk(cacheKey, chunk);
          },
          params.contextBefore,
          params.contextAfter
        );

        // Mark as completed
        this.completeStream(cacheKey);
      } catch (error: any) {
        console.error(`Error in stream ${cacheKey}:`, error);
        this.errorStream(cacheKey, error.message);
      }
    })();

    return stream.apiCallPromise;
  }

  getOrCreateStream(cacheKey: string, params: StreamParams): ActiveStream {
    // Check if stream already exists
    let stream = this.streams.get(cacheKey);

    if (stream) {
      console.log(`✓ Found existing stream: ${cacheKey} (status: ${stream.status})`);
      return stream;
    }

    // Create new stream
    stream = this.createStream(cacheKey, params);

    // Start the API call asynchronously
    this.startStream(cacheKey, params).catch(error => {
      console.error(`Failed to start stream ${cacheKey}:`, error);
    });

    return stream;
  }

  private scheduleCleanup(cacheKey: string): void {
    setTimeout(() => {
      const stream = this.streams.get(cacheKey);
      if (stream && stream.subscribers.size === 0) {
        this.streams.delete(cacheKey);
        console.log(`✓ Cleaned up completed stream: ${cacheKey}`);
      } else if (stream) {
        console.log(`✓ Keeping stream ${cacheKey} - still has ${stream.subscribers.size} subscribers`);
      }
    }, this.CLEANUP_DELAY);
  }

  private cleanupOldestCompletedStreams(): void {
    const completedStreams = Array.from(this.streams.entries())
      .filter(([_, stream]) => stream.status === 'completed' && stream.subscribers.size === 0)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    // Remove oldest 10% of completed streams
    const toRemove = Math.max(1, Math.floor(completedStreams.length * 0.1));
    for (let i = 0; i < toRemove && i < completedStreams.length; i++) {
      const [cacheKey] = completedStreams[i];
      this.streams.delete(cacheKey);
      console.log(`✓ Cleaned up old completed stream: ${cacheKey}`);
    }
  }

  getStats(): {
    totalStreams: number;
    activeStreams: number;
    completedStreams: number;
    erroredStreams: number;
    totalSubscribers: number;
    replayingSubscribers: number;
  } {
    let activeStreams = 0;
    let completedStreams = 0;
    let erroredStreams = 0;
    let totalSubscribers = 0;
    let replayingSubscribers = 0;

    for (const stream of this.streams.values()) {
      totalSubscribers += stream.subscribers.size;
      
      for (const subscriber of stream.subscribers.values()) {
        if (subscriber.isReplaying) {
          replayingSubscribers++;
        }
      }

      switch (stream.status) {
        case 'active':
          activeStreams++;
          break;
        case 'completed':
          completedStreams++;
          break;
        case 'error':
          erroredStreams++;
          break;
      }
    }

    return {
      totalStreams: this.streams.size,
      activeStreams,
      completedStreams,
      erroredStreams,
      totalSubscribers,
      replayingSubscribers
    };
  }
}

// Singleton instance
let streamManagerInstance: StreamManager | null = null;

export function getStreamManager(): StreamManager {
  if (!streamManagerInstance) {
    streamManagerInstance = new StreamManager();
    console.log('✓ StreamManager singleton created');
  }
  return streamManagerInstance;
}