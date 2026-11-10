import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function computeWordMatchPercent(source: string, spoken: string): number {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  const srcWords = clean(source);
  const spkSet = new Set(clean(spoken));
  if (srcWords.length === 0) return 0;
  const matched = srcWords.filter((w) => spkSet.has(w)).length;
  return Math.round((matched / srcWords.length) * 100);
}

export function ShadowingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [speechRate, setSpeechRate] = useState<number>(block.speechSpeed ?? 1.0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [hideTranscript, setHideTranscript] = useState<boolean>(Boolean(block.blindShadowing));
  const [downloadingYt, setDownloadingYt] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  useEffect(() => {
    if (block.speechSpeed) setSpeechRate(block.speechSpeed);
    setHideTranscript(Boolean(block.blindShadowing));
  }, [block.id, block.speechSpeed, block.blindShadowing]);

  const loadShadowingPassages = useCallback(async () => {
    const all = await db.questionBank.toArray();
    let manifest: Record<string, { audioUrl: string; text: string }> = {};
    try {
      const res = await fetch(`${BACKEND_BASE}/audio/manifest`);
      if (res.ok) {
        manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
      }
    } catch {
      // Backend offline or manifest empty
    }

    const updatedItems: QuestionBankItem[] = [];
    for (const q of all) {
      if (q.youtubeSource?.clipKey && manifest[q.youtubeSource.clipKey] && !q.audioUrl) {
        const cached = manifest[q.youtubeSource.clipKey];
        const upgraded: QuestionBankItem = {
          ...q,
          audioUrl: normalizeAudioUrl(cached.audioUrl),
          sourceAudioText: cached.text || q.sourceAudioText,
          prompt: cached.text || q.prompt,
        };
        await db.questionBank.put(upgraded);
        updatedItems.push(upgraded);
      } else {
        updatedItems.push({
          ...q,
          audioUrl: q.audioUrl ? normalizeAudioUrl(q.audioUrl) : q.audioUrl,
        });
      }
    }

    const shadowItems = updatedItems.filter(
      (q) =>
        Boolean(q.audioUrl) ||
        Boolean(q.youtubeSource) ||
        q.tags.includes('shadowing') ||
        q.type === 'read-aloud' ||
        Boolean(q.sourceAudioText)
    );
    shadowItems.sort(
      (a, b) =>
        (b.audioUrl ? 2 : b.youtubeSource ? 1 : 0) -
        (a.audioUrl ? 2 : a.youtubeSource ? 1 : 0)
    );
    const finalList = shadowItems.length > 0 ? shadowItems : updatedItems;
    setPassages(finalList);

    if (block.questionSetId) {
      const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
      if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
    }
  }, [block.questionSetId]);

  useEffect(() => {
    void loadShadowingPassages();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, [loadShadowingPassages]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const ytSource = currentItem?.youtubeSource;
  const sourceText =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.';

  useEffect(() => {
    const el = audioPlayerRef.current;
    if (!el) return;
    el.playbackRate = speechRate;
    if ('preservesPitch' in el) {
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }, [speechRate, humanAudioUrl]);

  const handleDownloadCuratedYoutube = async () => {
    if (!currentItem || !ytSource) return;
    setDownloadingYt(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_BASE}/audio/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytSource.url,
          startTime: ytSource.startTime,
          endTime: ytSource.endTime,
          clipKey: ytSource.clipKey,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Download failed' }));
        throw new Error(errData.detail || 'yt-dlp download failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
      };
      const updatedItem: QuestionBankItem = {
        ...currentItem,
        audioUrl: normalizeAudioUrl(data.audioUrl),
        sourceAudioText: data.text || currentItem.sourceAudioText,
        prompt: data.text || currentItem.prompt,
      };
      await db.questionBank.put(updatedItem);
      setPassages((prev) =>
        prev.map((p, idx) => (idx === selectedIdx ? updatedItem : p))
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to download YouTube clip. Make sure python app.py is running and yt-dlp is installed.'
      );
    } finally {
      setDownloadingYt(false);
    }
  };

  const playNativeAudio = useCallback(() => {
    if (humanAudioUrl && audioPlayerRef.current) {
      audioPlayerRef.current.playbackRate = speechRate;
      audioPlayerRef.current.currentTime = 0;
      void audioPlayerRef.current.play();
      setIsPlayingAudio(true);
      return;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sourceText);
      utterance.lang = 'en-US';
      utterance.rate = speechRate;
      utterance.onstart = () => setIsPlayingAudio(true);
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      window.speechSynthesis.speak(utterance);
    }
  }, [humanAudioUrl, sourceText, speechRate]);

  const stopNativeAudio = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  }, []);

  const rewindFiveSeconds = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.currentTime = Math.max(0, audioPlayerRef.current.currentTime - 5);
    }
  };

  const handleStartShadowing = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied. Use headphones so your mic only captures your voice.');
        return;
      }
      await recorder.start();
      recorderRef.current = recorder;
      recordDurationRef.current = 0;
      setRecordingSeconds(0);
      setRecordingState('recording');
      playNativeAudio();
      recTimerRef.current = setInterval(() => {
        recordDurationRef.current += 1;
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start shadowing.');
    }
  }, [playNativeAudio]);

  const handleStopShadowing = useCallback(async () => {
    stopNativeAudio();
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;
    setRecordingState('transcribing');
    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      const dataUrl = await blobToDataUrl(blob);
      const settings = await db.settings.get('app-settings');
      const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
        apiKey: settings?.sttApiKey,
        localWhisperUrl: settings?.localWhisperUrl,
      });
      const result = await stt.transcribe(blob, 'en');
      const actualDuration = result.durationSec ?? Math.max(5, recordDurationRef.current);
      const stats = analyzeSpeechTranscript(result.text, actualDuration);

      updateResponse(block.id, {
        audioBlobRef: dataUrl,
        textOrTranscript: result.text || '[No speech detected]',
        timestampedTranscript: result.timestampedText || result.text,
        audioDurationSec: actualDuration,
        promptSnapshot: sourceText,
        questionId: currentItem?.id,
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shadowing transcription failed');
      setRecordingState('idle');
    }
  }, [block.id, currentItem?.id, sourceText, stopNativeAudio, updateResponse]);

  const matchPercent = computeWordMatchPercent(sourceText, response?.textOrTranscript ?? '');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <WhisperLiveIndicator />
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
              humanAudioUrl
                ? 'bg-green-100 text-green-800 border border-green-300'
                : ytSource
                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {humanAudioUrl
              ? '🎙️ Real Human Audio Ready on Device'
              : ytSource
              ? `🎬 Curated YouTube Talk: ${ytSource.speaker}`
              : '⚠️ Synthetic TTS Fallback'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs font-semibold text-slate-600">Speed:</label>
          {[0.85, 0.95, 1.0, 1.1].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => setSpeechRate(rate)}
              className={`px-2 py-1 text-xs rounded-lg font-mono font-semibold border cursor-pointer ${
                speechRate === rate
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-700 border-slate-200'
              }`}
            >
              {rate}x
            </button>
          ))}
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                stopNativeAudio();
                setSelectedIdx(Number(e.target.value));
              }}
              className="text-xs font-semibold text-primary-800 bg-primary-50 border border-primary-200 px-2.5 py-1 rounded-lg cursor-pointer max-w-[220px]"
            >
              {passages.map((p, idx) => (
                <option key={p.id} value={idx}>
                  #{idx + 1} {p.sourceAttribution || p.prompt.slice(0, 35)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {!humanAudioUrl && ytSource && (
        <div className="bg-accent-50 border-2 border-accent-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-accent-800">
              🎬 Curated TED / Academic Talk Linked ({ytSource.speaker} • {ytSource.startTime}–{ytSource.endTime})
            </p>
            <p className="text-xs text-slate-600 mt-0.5">
              Click once to auto-download this real human audio slice to your device and transcribe it with Faster-Whisper.
            </p>
          </div>
          <button
            type="button"
            disabled={downloadingYt}
            onClick={handleDownloadCuratedYoutube}
            className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-lg disabled:opacity-50 cursor-pointer shadow-xs"
          >
            {downloadingYt
              ? '⏳ Downloading & Transcribing via GPU...'
              : '⬇️ Auto-Download Human Audio to Device'}
          </button>
        </div>
      )}

      {humanAudioUrl && (
        <div className="bg-slate-900 text-white rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>
              Human Reference Track ({currentItem?.sourceAttribution || 'Local MP3'} • Pitch-Preserved {speechRate}x)
            </span>
            <button
              type="button"
              onClick={rewindFiveSeconds}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded font-mono text-xs cursor-pointer"
            >
              ↺ Rewind -5s
            </button>
          </div>
          <audio
            ref={audioPlayerRef}
            controls
            src={humanAudioUrl}
            onPlay={() => setIsPlayingAudio(true)}
            onPause={() => setIsPlayingAudio(false)}
            onEnded={() => setIsPlayingAudio(false)}
            className="w-full h-10"
          />
        </div>
      )}

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
            Arguelles Shadowing Script ({currentItem?.sourceAttribution || 'Academic Passage'})
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHideTranscript((h) => !h)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-700 cursor-pointer"
            >
              {hideTranscript ? 'Show Transcript' : 'Blind Shadowing (Hide Text)'}
            </button>
            {!humanAudioUrl && (
              <button
                type="button"
                onClick={isPlayingAudio ? stopNativeAudio : playNativeAudio}
                className="text-xs font-semibold px-3 py-1 rounded-lg bg-white border border-primary-300 text-primary-800"
              >
                {isPlayingAudio ? 'Stop Audio' : 'Preview Audio'}
              </button>
            )}
          </div>
        </div>
        {hideTranscript ? (
          <p className="text-sm italic text-slate-500 py-4 text-center">
            Transcript hidden for pure auditory-motor shadowing. Listen closely to the human speaker's intonation!
          </p>
        ) : (
          <p className="text-base text-slate-900 leading-relaxed font-medium">{sourceText}</p>
        )}
      </div>

      <div className="flex justify-center">
        {recordingState !== 'recording' && recordingState !== 'transcribing' && (
          <button
            type="button"
            onClick={handleStartShadowing}
            className="px-7 py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-lg cursor-pointer flex items-center gap-3"
          >
            <span className="w-3 h-3 rounded-full bg-white animate-ping" />
            Play Human Audio & Record Your Shadowing Simultaneously
          </button>
        )}
        {recordingState === 'recording' && (
          <button
            type="button"
            onClick={handleStopShadowing}
            className="px-7 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm shadow-lg cursor-pointer"
          >
            Stop & Transcribe Shadowing ({recordingSeconds}s)
          </button>
        )}
      </div>

      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-5 text-center text-sm font-semibold text-accent-800">
          Transcribing shadowed speech & computing prosody alignment via Faster-Whisper...
        </div>
      )}

      {response?.textOrTranscript && recordingState !== 'recording' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Lexical Capture</p>
              <p className="text-lg font-bold text-primary-600">{matchPercent}% matched</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Shadowing Pace</p>
              <p className="text-lg font-bold text-slate-800">{response.wpm ?? 0} WPM</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Spoken Duration</p>
              <p className="text-lg font-bold text-slate-800">
                {response.audioDurationSec ?? recordingSeconds}s
              </p>
            </div>
          </div>

          {response.audioBlobRef && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">Your Recorded Shadowing:</p>
              <audio controls src={response.audioBlobRef} className="w-full h-9" />
            </div>
          )}

          {response.timestampedTranscript && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">
                Timestamped Shadowing Output (Sent to Gemini):
              </p>
              <pre className="text-xs font-mono bg-slate-900 text-green-300 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                {response.timestampedTranscript}
              </pre>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
