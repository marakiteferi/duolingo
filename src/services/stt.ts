import type { STTProvider as STTProviderType } from '../types';

export interface STTResult {
  text: string;
  timestampedText?: string;
  durationSec?: number;
}

export interface STTProvider {
  transcribe(audioBlob: Blob, language?: string): Promise<STTResult>;
  isAvailable(): boolean;
}

const LOCAL_WHISPER_DEFAULT_URL = 'http://127.0.0.1:8000/transcribe';
const LOCAL_WHISPER_HEALTH_URL = 'http://127.0.0.1:8000/health';
const OPENAI_WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BLOB_SIZE_BYTES = 24 * 1024 * 1024;

/**
 * Checks whether the local Python FastAPI faster-whisper server is online.
 */
export async function checkLocalWhisperHealth(
  transcribeUrl: string = LOCAL_WHISPER_DEFAULT_URL
): Promise<boolean> {
  try {
    const baseUrl = transcribeUrl.replace(/\/transcribe\/?$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return true;
    // Even if /health isn't added yet, a 404 from uvicorn means the server is up!
    return res.status === 404;
  } catch {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(LOCAL_WHISPER_HEALTH_URL, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}

/**
 * Analyzes a verbatim transcript for filler words, hesitations, and WPM.
 */
export function analyzeSpeechTranscript(text: string, durationSec: number): {
  wordCount: number;
  fillerCount: number;
  fillersFound: string[];
  wpm: number;
} {
  const clean = text.trim();
  if (!clean) {
    return { wordCount: 0, fillerCount: 0, fillersFound: [], wpm: 0 };
  }
  const words = clean.split(/\s+/);
  const wordCount = words.length;
  const fillerRegex = /\b(uh+|um+|er+|ah+|hmm+|like|you know|basically|literally)\b|\[(silent|cough|pause)\]/gi;
  const matches = clean.match(fillerRegex) ?? [];
  const minutes = Math.max(0.1, durationSec / 60);
  const wpm = Math.round(wordCount / minutes);

  return {
    wordCount,
    fillerCount: matches.length,
    fillersFound: matches.map((m) => m.toLowerCase()),
    wpm,
  };
}

/**
 * Primary Provider: Local Faster-Whisper running on RTX 3050 (http://127.0.0.1:8000/transcribe)
 */
export class LocalWhisperSTTProvider implements STTProvider {
  private readonly endpointUrl: string;

  constructor(endpointUrl: string = LOCAL_WHISPER_DEFAULT_URL) {
    this.endpointUrl = endpointUrl || LOCAL_WHISPER_DEFAULT_URL;
  }

  isAvailable(): boolean {
    return true;
  }

  async transcribe(audioBlob: Blob): Promise<STTResult> {
    const audioFile = new File([audioBlob], 'recording.webm', {
      type: audioBlob.type || 'audio/webm',
    });
    const formData = new FormData();
    formData.append('file', audioFile);

    let response: Response;
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        body: formData,
      });
    } catch {
      throw new Error(
        'Could not connect to local Whisper server at ' +
          this.endpointUrl +
          '. Make sure your Python terminal (python app.py) is running on port 8000.'
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown server error');
      throw new Error(`Local Whisper error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      text?: string;
      timestampedText?: string;
      duration?: number;
    };
    return {
      text: data.text ?? '',
      timestampedText: data.timestampedText,
      durationSec: data.duration,
    };
  }
}

/**
 * Optional Cloud OpenAI Whisper Provider
 */
export class WhisperSTTProvider implements STTProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(audioBlob: Blob, language: string = 'en'): Promise<STTResult> {
    if (audioBlob.size > MAX_BLOB_SIZE_BYTES) {
      throw new Error('Audio exceeds 24 MB limit.');
    }
    const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', audioFile);
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    formData.append('prompt', 'Uh, um, like, so yeah, well, [cough], [silent]...');

    const response = await fetch(OPENAI_WHISPER_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`OpenAI Whisper error (${response.status})`);
    }
    const data = (await response.json()) as { text?: string };
    return { text: data.text ?? '' };
  }
}

/**
 * Browser Web Speech API Fallback
 */
export class WebSpeechSTTProvider implements STTProvider {
  isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as unknown as Record<string, unknown>).SpeechRecognition ||
              (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
    );
  }

  async transcribe(_audioBlob: Blob): Promise<STTResult> {
    throw new Error(
      'Web Speech API only works in live-streaming mode. Use Local Whisper (port 8000) to transcribe recorded audio blobs.'
    );
  }
}

export function createSTTProvider(
  provider: STTProviderType,
  options?: { apiKey?: string; localWhisperUrl?: string }
): STTProvider {
  switch (provider) {
    case 'local-whisper':
      return new LocalWhisperSTTProvider(options?.localWhisperUrl);
    case 'whisper':
      if (!options?.apiKey) {
        return new LocalWhisperSTTProvider(options?.localWhisperUrl);
      }
      return new WhisperSTTProvider(options.apiKey);
    case 'web-speech-api':
      return new WebSpeechSTTProvider();
    default:
      return new LocalWhisperSTTProvider(options?.localWhisperUrl);
  }
}
