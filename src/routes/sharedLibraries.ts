import { Router, Request, Response } from 'express';
import {
  createSharedLibrary,
  findSharedLibraries,
  findSharedLibraryById,
  incrementDownloadCount,
  getFeaturedLibraries,
  createLibraryReport,
  updateSharedLibrary,
  CreateSharedLibraryInput,
  UpdateSharedLibraryInput,
} from '../db/sharedLibraries';
import { rateLimitMiddleware } from '../middleware/rateLimit';

const router = Router();

// --- Validation Helpers ---

const VALID_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
const MAX_WORDS_PER_LIBRARY = 1000;
const MAX_NAME_LENGTH = 100;
const MIN_NAME_LENGTH = 3;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_WORD_LENGTH = 255;
const MAX_TRANSLATION_LENGTH = 500;

function validateCreateInput(body: any): string | null {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (body.name.length < MIN_NAME_LENGTH) return `name must be at least ${MIN_NAME_LENGTH} characters`;
  if (body.name.length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`;

  if (body.description && body.description.length > MAX_DESCRIPTION_LENGTH) {
    return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  if (!body.difficulty || !VALID_DIFFICULTIES.includes(body.difficulty)) {
    return `difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}`;
  }

  if (!body.sourceLanguage || typeof body.sourceLanguage !== 'string') return 'sourceLanguage is required';
  if (!body.targetLanguage || typeof body.targetLanguage !== 'string') return 'targetLanguage is required';

  if (!Array.isArray(body.words) || body.words.length === 0) return 'words array is required and must not be empty';
  if (body.words.length > MAX_WORDS_PER_LIBRARY) return `words array must not exceed ${MAX_WORDS_PER_LIBRARY} items`;

  for (let i = 0; i < body.words.length; i++) {
    const w = body.words[i];
    if (!w.word || typeof w.word !== 'string') return `words[${i}].word is required`;
    if (w.word.length > MAX_WORD_LENGTH) return `words[${i}].word exceeds max length of ${MAX_WORD_LENGTH}`;
    if (!w.translation || typeof w.translation !== 'string') return `words[${i}].translation is required`;
    if (w.translation.length > MAX_TRANSLATION_LENGTH) return `words[${i}].translation exceeds max length of ${MAX_TRANSLATION_LENGTH}`;
  }

  if (body.tags && !Array.isArray(body.tags)) return 'tags must be an array';

  return null;
}

function validateUpdateInput(body: any): string | null {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (body.name.length < MIN_NAME_LENGTH) return `name must be at least ${MIN_NAME_LENGTH} characters`;
  if (body.name.length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`;

  if (body.description && body.description.length > MAX_DESCRIPTION_LENGTH) {
    return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  if (!body.difficulty || !VALID_DIFFICULTIES.includes(body.difficulty)) {
    return `difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}`;
  }

  if (!Array.isArray(body.words) || body.words.length === 0) return 'words array is required and must not be empty';
  if (body.words.length > MAX_WORDS_PER_LIBRARY) return `words array must not exceed ${MAX_WORDS_PER_LIBRARY} items`;

  for (let i = 0; i < body.words.length; i++) {
    const w = body.words[i];
    if (!w.word || typeof w.word !== 'string') return `words[${i}].word is required`;
    if (w.word.length > MAX_WORD_LENGTH) return `words[${i}].word exceeds max length of ${MAX_WORD_LENGTH}`;
    if (!w.translation || typeof w.translation !== 'string') return `words[${i}].translation is required`;
    if (w.translation.length > MAX_TRANSLATION_LENGTH) return `words[${i}].translation exceeds max length of ${MAX_TRANSLATION_LENGTH}`;
  }

  return null;
}

// UUID v4 format check
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

// --- Rate limit configs ---

const uploadRateLimit = rateLimitMiddleware({
  userLimit: 5,
  ipLimit: 5,
  windowMinutes: 60,
});

const browseRateLimit = rateLimitMiddleware({
  userLimit: 1000,
  ipLimit: 1000,
  windowMinutes: 60,
});

const downloadRateLimit = rateLimitMiddleware({
  userLimit: 100,
  ipLimit: 100,
  windowMinutes: 60,
});

// --- Routes ---

// GET /shared-libraries/featured - Get featured libraries
// (must be before /:id to avoid route conflict)
router.get('/featured', browseRateLimit, async (req: Request, res: Response) => {
  try {
    const targetLanguage = req.query.targetLanguage as string;
    if (!targetLanguage) {
      return res.status(400).json({ error: 'targetLanguage query parameter is required' });
    }

    const libraries = await getFeaturedLibraries(targetLanguage);
    return res.json({ libraries });
  } catch (error: any) {
    console.error('Error in GET /shared-libraries/featured:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /shared-libraries - Browse shared libraries
router.get('/', browseRateLimit, async (req: Request, res: Response) => {
  try {
    const targetLanguage = req.query.targetLanguage as string;
    if (!targetLanguage) {
      return res.status(400).json({ error: 'targetLanguage query parameter is required' });
    }

    const tagsParam = req.query.tags as string | undefined;
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : undefined;

    const result = await findSharedLibraries({
      targetLanguage,
      difficulty: req.query.difficulty as string | undefined,
      search: req.query.search as string | undefined,
      tags,
      sortBy: req.query.sortBy as 'popular' | 'newest' | 'wordCount' | undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    });

    return res.json(result);
  } catch (error: any) {
    console.error('Error in GET /shared-libraries:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /shared-libraries - Upload/share a library
router.post('/', async (req: Request, res: Response) => {
  try {
    const validationError = validateCreateInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const input: CreateSharedLibraryInput = {
      name: req.body.name.trim(),
      description: req.body.description?.trim(),
      difficulty: req.body.difficulty,
      color: req.body.color,
      icon: req.body.icon,
      sourceLanguage: req.body.sourceLanguage,
      targetLanguage: req.body.targetLanguage,
      authorName: req.body.authorName?.trim(),
      tags: req.body.tags,
      words: req.body.words.map((w: any) => ({
        word: w.word.trim(),
        translation: w.translation.trim(),
        transcription: w.transcription?.trim(),
      })),
    };

    const library = await createSharedLibrary(input);

    return res.status(201).json({
      id: library.id,
      name: library.name,
      wordCount: library.wordCount,
      shareUrl: `tickword://library/${library.id}`,
    });
  } catch (error: any) {
    console.error('Error in POST /shared-libraries:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// PUT /shared-libraries/:id - Update a library
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid library ID format' });
    }

    const validationError = validateUpdateInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const input: UpdateSharedLibraryInput = {
      name: req.body.name.trim(),
      description: req.body.description?.trim(),
      difficulty: req.body.difficulty,
      color: req.body.color,
      icon: req.body.icon,
      words: req.body.words.map((w: any) => ({
        word: w.word.trim(),
        translation: w.translation.trim(),
        transcription: w.transcription?.trim(),
      })),
    };

    const result = await updateSharedLibrary(id, input);
    if (!result) {
      return res.status(404).json({ error: 'Library not found' });
    }

    return res.json(result);
  } catch (error: any) {
    console.error('Error in PUT /shared-libraries/:id:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /shared-libraries/:id - Get library details with words
router.get('/:id', browseRateLimit, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid library ID format' });
    }

    const library = await findSharedLibraryById(id);
    if (!library) {
      return res.status(404).json({ error: 'Library not found' });
    }

    return res.json({
      id: library.id,
      name: library.name,
      description: library.description,
      difficulty: library.difficulty,
      color: library.color,
      icon: library.icon,
      sourceLanguage: library.sourceLanguage,
      targetLanguage: library.targetLanguage,
      authorName: library.authorName,
      wordCount: library.wordCount,
      downloadCount: library.downloadCount,
      isFeatured: library.isFeatured,
      tags: library.tags,
      words: library.words.map(w => ({
        word: w.word,
        translation: w.translation,
        transcription: w.transcription,
      })),
      createdAt: library.createdAt,
    });
  } catch (error: any) {
    console.error('Error in GET /shared-libraries/:id:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /shared-libraries/:id/download - Download library (increment counter)
router.post('/:id/download', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid library ID format' });
    }

    const library = await findSharedLibraryById(id);
    if (!library) {
      return res.status(404).json({ error: 'Library not found' });
    }

    await incrementDownloadCount(id);

    return res.json({
      success: true,
      library: {
        id: library.id,
        name: library.name,
        description: library.description,
        difficulty: library.difficulty,
        color: library.color,
        icon: library.icon,
        sourceLanguage: library.sourceLanguage,
        targetLanguage: library.targetLanguage,
        authorName: library.authorName,
        wordCount: library.wordCount,
        downloadCount: library.downloadCount + 1,
        tags: library.tags,
        words: library.words.map(w => ({
          word: w.word,
          translation: w.translation,
          transcription: w.transcription,
        })),
        createdAt: library.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Error in POST /shared-libraries/:id/download:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /shared-libraries/:id/report - Report a library
router.post('/:id/report', browseRateLimit, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid library ID format' });
    }

    const { reason, description } = req.body;
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ error: 'reason is required' });
    }

    const library = await findSharedLibraryById(id);
    if (!library) {
      return res.status(404).json({ error: 'Library not found' });
    }

    const reporterIp = (req.ip || req.socket.remoteAddress || null) as string | null;
    await createLibraryReport(id, reason, description || null, reporterIp);

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error in POST /shared-libraries/:id/report:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default router;
