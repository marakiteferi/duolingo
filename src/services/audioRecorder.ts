/**
 * Audio recording service wrapping the MediaRecorder API.
 *
 * Handles:
 *   - MIME type detection (prefers webm/opus, falls back to mp4)
 *   - Microphone permission requests
 *   - Chunk collection and merging into a single Blob
 *   - AnalyserNode exposure for waveform / level-meter visualization
 *   - Graceful cleanup of media streams
 */

// ─── MIME Type Priority ──────────────────────────────────────────────────────

/** Ordered list of MIME types to try — best quality/support first */
const MIME_CANDIDATES: string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// ─── AudioRecorderService ────────────────────────────────────────────────────

/**
 * Service that wraps the browser MediaRecorder API to record audio from
 * the user's microphone. Provides an AnalyserNode for visualisation.
 *
 * Usage:
 *   const recorder = new AudioRecorderService();
 *   await recorder.requestPermission();
 *   await recorder.start();
 *   // ... user speaks ...
 *   const blob = await recorder.stop();
 */
export class AudioRecorderService {
  /** The active MediaRecorder instance */
  private mediaRecorder: MediaRecorder | null = null;

  /** Collected audio data chunks */
  private chunks: Blob[] = [];

  /** The active microphone MediaStream */
  private stream: MediaStream | null = null;

  /** The MIME type in use for the current (or most recent) recording */
  private mimeType: string = '';

  /** Web Audio context and analyser for waveform visualisation */
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  // ── Static Helpers ───────────────────────────────────────────────────────

  /**
   * Query the browser's microphone permission state without prompting the user.
   *
   * @returns 'granted', 'denied', or 'prompt' (user hasn't been asked yet).
   *          Falls back to 'prompt' if the Permissions API isn't available.
   */
  static async checkMicPermission(): Promise<PermissionState> {
    try {
      // The Permissions API is not universally supported for 'microphone'
      if (navigator.permissions) {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        return status.state;
      }
    } catch {
      // Some browsers throw on querying 'microphone' — fall through
    }
    return 'prompt';
  }

  /**
   * Determine the best supported MIME type for audio recording.
   *
   * Checks each candidate in priority order using `MediaRecorder.isTypeSupported()`.
   * Returns an empty string if none are supported (should be very rare).
   */
  static getSupportedMimeType(): string {
    if (typeof MediaRecorder === 'undefined') {
      return '';
    }

    for (const mime of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }

    // Last resort: let the browser pick
    return '';
  }

  // ── Instance Methods ─────────────────────────────────────────────────────

  /**
   * Request microphone access from the user.
   *
   * This must be called before `start()`. On success the stream is stored
   * internally and an AnalyserNode is wired up for visualisation.
   *
   * @returns `true` if permission was granted, `false` otherwise.
   */
  async requestPermission(): Promise<boolean> {
    try {
      // Request audio-only stream
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Determine the MIME type we'll record with
      this.mimeType = AudioRecorderService.getSupportedMimeType();

      // Wire up Web Audio analyser for waveform / volume metering
      this.setupAnalyser();

      return true;
    } catch (error) {
      // Permission denied or no microphone
      console.warn('[AudioRecorder] Permission denied or unavailable:', error);
      this.stream = null;
      return false;
    }
  }

  /**
   * Start recording audio from the microphone.
   *
   * @throws If `requestPermission()` has not been called or was denied.
   */
  async start(): Promise<void> {
    if (!this.stream) {
      throw new Error(
        'No active media stream. Call requestPermission() first.'
      );
    }

    // Reset chunks from any previous recording
    this.chunks = [];

    // Build recorder options
    const options: MediaRecorderOptions = {};
    if (this.mimeType) {
      options.mimeType = this.mimeType;
    }

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch {
      // If the preferred MIME failed, try without specifying one
      this.mediaRecorder = new MediaRecorder(this.stream);
      this.mimeType = this.mediaRecorder.mimeType;
    }

    // Collect chunks as data becomes available
    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    // Request data every 250ms for smoother chunk collection
    this.mediaRecorder.start(250);
  }

  /**
   * Stop recording and return the full audio as a single Blob.
   *
   * Also cleans up the media stream and audio context.
   *
   * @returns A Blob containing the recorded audio.
   * @throws If recording has not been started.
   */
  stop(): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        reject(new Error('Recorder is not currently recording.'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        // Merge all chunks into a single blob
        const mimeType = this.mimeType || this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];

        // Clean up the stream and audio nodes
        this.cleanup();

        resolve(blob);
      };

      this.mediaRecorder.onerror = (event) => {
        this.cleanup();
        reject(new Error(`MediaRecorder error: ${(event as ErrorEvent).message ?? 'unknown'}`));
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Get the actual MIME type used for recording.
   * Useful for constructing the correct file extension when uploading.
   */
  getMimeType(): string {
    return this.mimeType || (this.mediaRecorder?.mimeType ?? '');
  }

  /** Returns `true` if the recorder is currently capturing audio. */
  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording';
  }

  /**
   * Get the AnalyserNode for waveform or volume visualisation.
   *
   * Returns `null` if recording has not been initialised or has been cleaned up.
   * Connect this to a canvas or `getByteFrequencyData()` / `getByteTimeDomainData()`.
   */
  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Create an AudioContext and wire the microphone stream through an AnalyserNode.
   */
  private setupAnalyser(): void {
    if (!this.stream) return;

    try {
      this.audioContext = new AudioContext();
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.8;

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.sourceNode.connect(this.analyserNode);
      // Note: we do NOT connect the analyser to audioContext.destination —
      // we don't want the user to hear their own voice played back.
    } catch (error) {
      console.warn('[AudioRecorder] Failed to set up analyser:', error);
      this.analyserNode = null;
    }
  }

  /**
   * Clean up all resources: stop stream tracks, close audio context,
   * and null out references.
   */
  private cleanup(): void {
    // Stop all tracks on the media stream
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    // Disconnect and close audio nodes
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        // Ignore errors on close — context may already be closed
      });
      this.audioContext = null;
    }

    this.mediaRecorder = null;
  }
}
