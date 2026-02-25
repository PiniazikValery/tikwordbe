import { execSync } from 'child_process';

let whisperAvailable = false;

/**
 * Check if a Docker image exists locally.
 */
function isDockerImageAvailable(imageName: string): boolean {
  try {
    execSync(`docker image inspect ${imageName}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check Whisper Docker image availability on startup.
 * Sets internal flag that can be queried later.
 */
export function checkWhisperAvailability(): boolean {
  const useGPU = process.env.USE_GPU === 'true';
  const imageName = useGPU ? 'tickword-whisper-gpu:latest' : 'tickword-whisper:latest';

  whisperAvailable = isDockerImageAvailable(imageName);

  if (whisperAvailable) {
    console.log(`  ✓ Whisper Docker image found: ${imageName}`);
  } else {
    console.log(`  ⚠ Whisper Docker image NOT found: ${imageName}`);
    console.log(`    Whisper fallback will be disabled. Only YouTube subtitles will be used.`);
  }

  return whisperAvailable;
}

export function isWhisperAvailable(): boolean {
  return whisperAvailable;
}
