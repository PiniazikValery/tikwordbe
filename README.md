# TickWord Backend - YouTube Video Segment Search

Backend API for finding YouTube video segments where specific words or sentences are spoken, with precise sentence boundary detection.

## Features

- Accepts a word or sentence and finds matching YouTube videos
- Returns precise video segments with start/end times
- Intelligent sentence boundary detection for natural clip endings
- Permanent caching to minimize API calls
- No scraping - uses official YouTube Data API v3

## Tech Stack

- Node.js (LTS)
- TypeScript
- Express.js
- PostgreSQL
- YouTube Data API v3
- YouTube Captions API

## Prerequisites

- Node.js 18+ installed
- PostgreSQL installed and running
- YouTube Data API v3 key ([Get one here](https://console.cloud.google.com/apis/credentials))

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```bash
cp .env.example .env
```

Edit `.env` and add your YouTube API key and database credentials.

4. Create the PostgreSQL database:

```sql
CREATE DATABASE tickword;
```

The database schema will be automatically created when you start the server.

## Running the Server

Development mode (with hot reload):

```bash
npm run dev
```

Production mode:

```bash
npm run build
npm start
```

The server will start on `http://localhost:3000` by default.

## API Endpoints

### POST /youtube/search

Search for a YouTube video segment containing a word or sentence.

**Request:**

```json
{
  "query": "awkward moment"
}
```

**Response (Success):**

```json
{
  "videoId": "dQw4w9WgXcQ",
  "startTime": 52.4,
  "endTime": 57.8,
  "caption": "This was kind of an awkward moment."
}
```

**Response (Error - No match found):**

```json
{
  "error": "No matching sentence found in captions"
}
```

**Response (Error - No captions):**

```json
{
  "error": "No English captions available for this video"
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## How It Works

1. **Normalize Input**: Trim, lowercase, validate (max 200 chars)
2. **Detect Type**: Auto-detect if input is a word or sentence
3. **Cache Lookup**: Check database for existing results
4. **YouTube Search**: Search for relevant videos (max 5 results)
5. **Caption Retrieval**: Get English captions from videos
6. **Caption Matching**: Find segments containing the query
7. **Sentence Boundary Detection**: Extend segment to complete sentence + 2 second buffer
8. **Cache Result**: Store successful matches permanently
9. **Return Result**: Send video segment details to client

## Database Schema

```sql
CREATE TABLE video_examples (
  id UUID PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  query TEXT NOT NULL,
  video_id TEXT NOT NULL,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  caption TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Performance & Cost Optimization

- One YouTube API search per unique query
- All successful results cached forever
- Maximum 3 videos scanned per query
- Cached results returned instantly without API calls

## Project Structure

```
src/
├── routes/
│   └── youtubeSearch.ts    # Main search endpoint
├── services/
│   ├── youtube.ts          # YouTube Data API integration
│   ├── captions.ts         # Caption retrieval
│   └── sentenceDetector.ts # Sentence boundary detection
├── db/
│   └── videoExamples.ts    # Database operations
├── utils/
│   ├── hash.ts             # Query hashing
│   └── normalize.ts        # Input normalization
└── server.ts               # Express server setup
```

## Error Handling

The API handles the following error cases:

- Invalid or missing query
- Query exceeds 200 characters
- No videos found
- No captions available
- No matching segments found
- YouTube API quota exceeded
- Database errors

## Usage Example

Using curl:

```bash
curl -X POST http://localhost:3000/youtube/search \
  -H "Content-Type: application/json" \
  -d '{"query": "awkward moment"}'
```

Using JavaScript (fetch):

```javascript
const response = await fetch('http://localhost:3000/youtube/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'awkward moment' })
});

const data = await response.json();
console.log(data);
// { videoId: "...", startTime: 52.4, endTime: 57.8, caption: "..." }
```

## Frontend Integration

Embed the video segment using the YouTube IFrame API:

```html
<iframe
  width="560"
  height="315"
  src="https://www.youtube.com/embed/VIDEO_ID?start=START_TIME&end=END_TIME"
  frameborder="0"
  allow="autoplay; encrypted-media"
  allowfullscreen>
</iframe>
```

Replace `VIDEO_ID`, `START_TIME`, and `END_TIME` with values from the API response.

## License

ISC
