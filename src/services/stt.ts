/**
 * Speech-to-Text service interface and implementations.
 *
 * Provides two STT backends:
 *   1. WhisperSTTProvider  — OpenAI Whisper API (high accuracy, requires API key)
 *   2. WebSpeechSTTProvider — Browser SpeechRecognition API (free fallback, less accurate)
 *
 * Use the `createSTTProvider` factory to instantiate the desired provider.
 */

// ─── STT Provider Interface ──────────────────────────────────────────────────

/** Abstracted interface every STT backend must satisfy */
export interface STTProvider {
  /** Transcribe an audio blob to text */
  transcribe(audioBlob: Blob, language?: string): Promise<string>;
  /** Returns true if this provider can be used in the current environment */
  isAvailable(): boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** OpenAI Whisper endpoint */
const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Whisper API file-size hard limit is 25 MB; we guard at 24 MB for safety */
const MAX_BLOB_SIZE_BYTES = 24 * 1024 * 1024;

/** Map MIME types to file extensions Whisper expects */
const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/webm;codecs=opus': 'webm',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

// ─── Whisper STT Provider ────────────────────────────────────────────────────

/**
 * Transcription via OpenAI's Whisper API.
 *
 * Sends the audio blob as multipart/form-data and returns the transcript text.
 * Requires a valid OpenAI API key.
 */
export class WhisperSTTProvider implements STTProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /** Whisper is available as long as we have a non-empty API key */
  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(audioBlob: Blob, language: string = 'en'): Promise<string> {
    // ── Guard: blob size ──
    if (audioBlob.size > MAX_BLOB_SIZE_BYTES) {
      throw new Error(
        `Audio blob is ${(audioBlob.size / 1024 / 1024).toFixed(1)} MB — ` +
        `exceeds the 24 MB limit for Whisper API.`
      );
    }

    // ── Determine file extension from MIME type ──
    const ext = MIME_TO_EXT[audioBlob.type] ?? 'webm'; // default to webm
    const filename = `recording.${ext}`;

    // ── Build multipart form data ──
    const formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('model', 'whisper-1');
    formData.append('language', language);

    try {
      const response = await fetch(WHISPER_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          // Note: do NOT set Content-Type — the browser sets it with the boundary
        },
        body: formData,
      });

      // ── Handle HTTP errors ──
      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');

        if (response.status === 401) {
          throw new Error('Invalid OpenAI API key. Please check your settings.');
        }
        if (response.status === 429) {
          throw new Error('OpenAI rate limit exceeded. Please wait a moment and try again.');
        }
        if (response.status === 413) {
          throw new Error('Audio file too large for the Whisper API.');
        }

        throw new Error(
          `Whisper API error (${response.status}): ${errorBody}`
        );
      }

      const data = (await response.json()) as { text?: string };

      if (typeof data.text !== 'string') {
        throw new Error('Unexpected response format from Whisper API.');
      }

      return data.text;
    } catch (error) {
      // Re-throw our own errors, wrap unknown ones
      if (error instanceof Error) {
        // Network errors or our custom errors
        throw error;
      }
      throw new Error(`Whisper transcription failed: ${String(error)}`);
    }
  }
}

// ─── Web Speech API Provider ─────────────────────────────────────────────────

/**
 * Fallback STT using the browser's built-in SpeechRecognition API.
 *
 * Note: This performs *real-time* recognition from the microphone, NOT
 * transcription of a pre-recorded blob. The `audioBlob` parameter is ignored —
 * the browser listens directly.  This is a convenience fallback; Whisper
 * should be preferred for accuracy.
 */
export class WebSpeechSTTProvider implements STTProvider {
  /** Check if the browser supports the SpeechRecognition API */
  isAvailable(): boolean {
    return typeof window !== 'undefined' &&
      !!(
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition
      );
  }

  /**
   * Start real-time speech recognition and resolve with the final transcript.
   *
   * @param _audioBlob — Ignored; included for interface compatibility.
   * @param language   — BCP-47 language code (default: 'en-US').
   */
  async transcribe(_audioBlob: Blob, language: string = 'en-US'): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error(
        'SpeechRecognition API is not supported in this browser.'
      );
    }

    const SpeechRecognitionCtor: typeof SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    return new Promise<string>((resolve, reject) => {
      const recognition = new SpeechRecognitionCtor();

      // ── Configuration ──
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = language;

      let transcript = '';

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        // Accumulate all final results
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            transcript += event.results[i][0].transcript;
          }
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        // 'no-speech' is non-fatal — just means silence was detected
        if (event.error === 'no-speech') {
          return;
        }
        reject(new Error(`Speech recognition error: ${event.error}`));
      };

      recognition.onend = () => {
        // Resolve with whatever transcript was collected
        resolve(transcript.trim());
      };

      recognition.start();

      // Safety timeout: stop after 60 seconds to prevent hanging
      setTimeout(() => {
        try {
          recognition.stop();
        } catch {
          // Already stopped — ignore
        }
      }, 60_000);
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an STT provider instance.
 *
 * @param provider — Which backend to use.
 * @param apiKey   — Required for 'whisper'; ignored for 'web-speech-api'.
 */
export function createSTTProvider(
  provider: 'whisper' | 'web-speech-api',
  apiKey?: string,
): STTProvider {
  switch (provider) {
    case 'whisper': {
      if (!apiKey) {
        throw new Error('An OpenAI API key is required for Whisper STT.');
      }
      return new WhisperSTTProvider(apiKey);
    }
    case 'web-speech-api': {
      return new WebSpeechSTTProvider();
    }
    default:
      throw new Error(`Unknown STT provider: ${provider}`);
  }
}
