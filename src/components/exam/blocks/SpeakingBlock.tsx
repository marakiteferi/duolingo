import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore, selectBlockTimeRemaining } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function SpeakingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const activeRun = useSessionStore((s) => s.activeRun);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);
  const communicativePressure = activeRun?.communicativePressure ?? false;

  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(new Array(32).fill(0));
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [prompts, setPrompts] = useState<QuestionBankItem[]>([]);
  const [selectedPromptIdx, setSelectedPromptIdx] = useState(0);
  const [transcribeProgress, setTranscribeProgress] = useState(0);
  const [transcribeStage, setTranscribeStage] = useState('');

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const animFrameRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];
  const transcript = response?.textOrTranscript ?? '';
  const timestampedTranscript = response?.timestampedTranscript ?? '';

  useEffect(() => {
    getAdaptiveQuestions({
      skill: 'speaking',
      questionType: activeRun?.preferredQuestionType ?? 'adaptive',
      limit: 8,
    }).then(({ selected }) => {
      setPrompts(selected);
    });
  }, [activeRun?.preferredQuestionType]);

  const activePromptText =
    response?.promptSnapshot ||
    prompts[selectedPromptIdx]?.prompt ||
    block.instructions ||
    'Speak for 90 seconds expanding on your structured outline. Aim for smooth transitions and minimal hesitations.';

  const animateWaveform = useCallback(() => {
    const recorder = recorderRef.current;
    const analyser = recorder?.getAnalyser();
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const buckets = 32;
    const step = Math.floor(data.length / buckets);
    const newLevels = Array.from({ length: buckets }, (_, i) =>
      Math.round((data[i * step] / 255) * 100)
    );
    setLevels(newLevels);
    animFrameRef.current = requestAnimationFrame(animateWaveform);
  }, []);

  const transcribeBlob = useCallback(
    async (blob: Blob, fallbackDurationSec: number) => {
      setRecordingState('transcribing');
      setTranscribeProgress(20);
      setTranscribeStage('Sending audio to Faster-Whisper for timestamped alignment...');
      setError(null);

      const progressInterval = setInterval(() => {
        setTranscribeProgress((prev) => (prev < 88 ? prev + 8 : prev));
      }, 220);

      try {
        const dataUrl = await blobToDataUrl(blob);
        const settings = await db.settings.get('app-settings');
        const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
          apiKey: settings?.sttApiKey,
          localWhisperUrl: settings?.localWhisperUrl || settings?.localSttEndpoint,
        });
        const result = await stt.transcribe(blob, 'en');
        clearInterval(progressInterval);
        const verifiedDuration = Math.max(
          1,
          Math.round(result.durationSec ?? fallbackDurationSec)
        );
        const stats = analyzeSpeechTranscript(result.text, verifiedDuration);

        updateResponse(block.id, {
          audioBlobRef: dataUrl,
          textOrTranscript: result.text || '[No speech detected in recording]',
          timestampedTranscript: result.timestampedText || result.text,
          audioDurationSec: verifiedDuration,
          timeSpentSec: verifiedDuration,
          promptSnapshot: activePromptText,
          fillerCount: stats.fillerCount,
          wpm: stats.wpm,
        });
        setTranscribeProgress(100);
        setTranscribeStage('Timestamped transcription complete!');
        setTimeout(() => setRecordingState('done'), 250);
      } catch (err) {
        clearInterval(progressInterval);
        const msg = err instanceof Error ? err.message : 'Transcription failed';
        setError(msg);
        const fallbackUrl = await blobToDataUrl(blob).catch(() => '');
        updateResponse(block.id, {
          audioBlobRef: fallbackUrl,
          promptSnapshot: activePromptText,
          textOrTranscript: transcript || '',
          audioDurationSec: fallbackDurationSec,
        });
        setRecordingState('done');
      }
    },
    [activePromptText, block.id, transcript, updateResponse]
  );

  const handleStop = useCallback(async () => {
    cancelAnimationFrame(animFrameRef.current);
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setLevels(new Array(32).fill(0));
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;
    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      await transcribeBlob(blob, recordDurationRef.current);
    } catch (e) {
      setError(`Recording failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setRecordingState('idle');
    }
  }, [transcribeBlob]);

  useEffect(() => {
    if (recordingState === 'recording' && blockTimeRemaining <= 1) {
      void handleStop();
    }
  }, [blockTimeRemaining, recordingState, handleStop]);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied. Please allow microphone access in your browser.');
        return;
      }
      await recorder.start();
      recorderRef.current = recorder;
      recordDurationRef.current = 0;
      setRecordingSeconds(0);
      setRecordingState('recording');
      animateWaveform();
      recTimerRef.current = setInterval(() => {
        recordDurationRef.current += 1;
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      setError(`Could not start recording: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }, [animateWaveform]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, []);

  const handleRerecord = () => {
    setRecordingState('idle');
    setRecordingSeconds(0);
    updateResponse(block.id, {
      previousDraft: transcript || response?.previousDraft,
      audioBlobRef: undefined,
      textOrTranscript: '',
      timestampedTranscript: undefined,
      audioDurationSec: undefined,
      fillerCount: undefined,
      wpm: undefined,
    });
  };

  const handleCyclePrompt = () => {
    if (prompts.length === 0) return;
    const nextIdx = (selectedPromptIdx + 1) % prompts.length;
    setSelectedPromptIdx(nextIdx);
    updateResponse(block.id, {
      promptSnapshot: prompts[nextIdx].prompt,
      questionId: prompts[nextIdx].id,
      questionType: prompts[nextIdx].type,
    });
  };

  const effectiveDuration =
    response?.audioDurationSec || recordingSeconds || response?.timeSpentSec || 60;
  const speechStats = analyzeSpeechTranscript(transcript, effectiveDuration);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WhisperLiveIndicator />
        <div className="flex items-center gap-2">
          {communicativePressure && (
            <span className="text-xs font-bold bg-red-100 text-red-800 px-2.5 py-1 rounded-full">
              Communicative Pressure: Stop Button Locked Until Timer Ends
            </span>
          )}
          {prompts.length > 1 && (
            <button
              type="button"
              onClick={handleCyclePrompt}
              className="text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 px-3 py-1 rounded-lg"
            >
              Switch Speaking Prompt ({selectedPromptIdx + 1}/{prompts.length})
            </button>
          )}
        </div>
      </div>

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-primary-700 uppercase tracking-wide">
            Speaking Prompt ({prompts[selectedPromptIdx]?.type ?? 'speaking-sample'})
          </p>
          <span className="text-xs text-primary-600 font-medium">
            Target: 60–90s • 130–150 WPM • Attempt #{response?.attemptCount ?? 1}
          </span>
        </div>
        <p className="text-base text-slate-800 leading-relaxed font-medium">{activePromptText}</p>
      </div>

      {response?.previousDraft && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
          <strong>Previous Spoken Attempt (Fix your marked hesitations/errors):</strong>
          <p className="mt-1 italic text-slate-700">{response.previousDraft}</p>
        </div>
      )}

      {recordingState === 'recording' && (
        <div className="bg-slate-900 rounded-xl p-5 shadow-inner">
          <div className="flex items-end justify-center gap-1 h-20">
            {levels.map((level, i) => (
              <div
                key={i}
                className="w-2 rounded-sm bg-primary-400 transition-all duration-75"
                style={{ height: `${Math.max(6, level)}%` }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-300 mt-3 pt-2 border-t border-slate-800">
            <span className="flex items-center gap-2 text-red-400 font-semibold">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
              Recording Verbatim Audio with Segment Timestamps...
            </span>
            <span className="font-mono text-sm text-white">{recordingSeconds}s recorded</span>
          </div>
        </div>
      )}

      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold text-accent-800">
            <span>{transcribeStage}</span>
            <span className="font-mono">{transcribeProgress}%</span>
          </div>
          <div className="w-full bg-accent-200/80 h-3 rounded-full overflow-hidden">
            <div
              className="bg-accent-600 h-full rounded-full transition-all duration-200"
              style={{ width: `${transcribeProgress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col items-center gap-4">
        {recordingState === 'idle' && !response?.audioBlobRef && (
          <button
            type="button"
            onClick={handleStart}
            className="px-8 py-4 rounded-2xl bg-red-500 hover:bg-red-600 text-white font-bold text-base flex items-center gap-3 shadow-lg cursor-pointer"
          >
            <span className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
            Start Speaking Recording
          </button>
        )}
        {recordingState === 'recording' && !communicativePressure && (
          <button
            type="button"
            onClick={handleStop}
            className="px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-base flex items-center gap-3 shadow-lg cursor-pointer"
          >
            <span className="w-3.5 h-3.5 rounded-sm bg-red-500" />
            Stop & Transcribe Now ({recordingSeconds}s)
          </button>
        )}
      </div>

      {response?.audioBlobRef && recordingState !== 'recording' && recordingState !== 'transcribing' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-green-700">
              ✓ Audio Captured (Verified Duration: {effectiveDuration}s)
            </span>
            <button
              type="button"
              onClick={handleRerecord}
              className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
            >
              Re-Record & Fix Hesitations
            </button>
          </div>

          <audio controls src={response.audioBlobRef} className="w-full h-10" />

          <div className="grid grid-cols-4 gap-3 pt-1">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Spoken Duration</p>
              <p className="text-lg font-bold text-primary-700">{effectiveDuration}s</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Word Count</p>
              <p className="text-lg font-bold text-slate-900">{speechStats.wordCount} words</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Speaking Pace</p>
              <p
                className={`text-lg font-bold ${
                  speechStats.wpm >= 115 && speechStats.wpm <= 165 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                {speechStats.wpm} WPM
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Verbatim Fillers</p>
              <p
                className={`text-lg font-bold ${
                  speechStats.fillerCount <= 2 ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {speechStats.fillerCount} detected
              </p>
            </div>
          </div>

          {timestampedTranscript && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Timestamped & Pause-Annotated Transcript (Sent directly to Gemini AI):
              </label>
              <textarea
                value={timestampedTranscript}
                onChange={(e) =>
                  updateResponse(block.id, {
                    timestampedTranscript: e.target.value,
                    textOrTranscript: e.target.value,
                  })
                }
                rows={5}
                className="w-full p-3 text-xs font-mono text-green-300 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none"
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
