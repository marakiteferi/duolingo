import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore, selectBlockTimeRemaining } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import {
  getAdaptiveQuestions,
  markQuestionCompleted,
} from '../../../utils/adaptive';
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
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(new Array(32).fill(0));
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [prompts, setPrompts] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedPromptIdx, setSelectedPromptIdx] = useState(0);

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const animFrameRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];
  const transcript = response?.textOrTranscript ?? '';
  const timestampedTranscript = response?.timestampedTranscript ?? '';

  useEffect(() => {
    const preferredType =
      block.preferredQuestionType ?? activeRun?.preferredQuestionType ?? 'adaptive';
    getAdaptiveQuestions({
      skill: 'speaking',
      questionType:
        preferredType === 'speaking-sample' || preferredType === 'interactive-speaking'
          ? preferredType
          : 'adaptive',
      limit: 25,
    }).then(({ selected, completedIds: doneSet }) => {
      // Filter to speaking monologue prompts (exclude read-aloud shadowing unless none left)
      const monologueItems = selected.filter(
        (q) => q.type === 'speaking-sample' || q.type === 'interactive-speaking'
      );
      const list = monologueItems.length > 0 ? monologueItems : selected;
      setPrompts(list);
      setCompletedIds(new Set(doneSet));

      if (list.length > 0) {
        let idx = 0;
        if (block.questionSetId) {
          const pinned = list.findIndex((q) => q.id === block.questionSetId);
          if (pinned >= 0) idx = pinned;
        } else {
          const firstUnseen = list.findIndex((q) => !doneSet.has(q.id));
          if (firstUnseen >= 0) idx = firstUnseen;
        }
        setSelectedPromptIdx(idx);
      }
    });
  }, [activeRun?.preferredQuestionType, block.preferredQuestionType, block.questionSetId]);

  const activePromptItem = prompts[selectedPromptIdx] ?? null;
  const activePromptText =
    activePromptItem?.prompt ||
    response?.promptSnapshot ||
    block.instructions ||
    'Speak for 90 seconds on the prompt below. Aim for clear clause structure and minimal filler hesitations.';

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
    async (blob: Blob, durationSec: number) => {
      setRecordingState('transcribing');
      setError(null);
      try {
        const dataUrl = await blobToDataUrl(blob);
        const settings = await db.settings.get('app-settings');
        const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
          apiKey: settings?.sttApiKey,
          localWhisperUrl: settings?.localWhisperUrl,
        });
        const result = await stt.transcribe(blob, 'en');
        const actualDuration = result.durationSec ?? Math.max(5, durationSec);
        const stats = analyzeSpeechTranscript(result.text, actualDuration);

        if (activePromptItem?.id) {
          void markQuestionCompleted(activePromptItem.id);
          setCompletedIds((prev) => new Set(prev).add(activePromptItem.id));
        }

        updateResponse(block.id, {
          audioBlobRef: dataUrl,
          questionId: activePromptItem?.id,
          questionType: activePromptItem?.type ?? 'speaking-sample',
          textOrTranscript: result.text || '[No speech detected in recording]',
          timestampedTranscript: result.timestampedText || result.text,
          audioDurationSec: actualDuration,
          promptSnapshot: activePromptText,
          fillerCount: stats.fillerCount,
          wpm: stats.wpm,
        });
        setRecordingState('done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transcription failed';
        setError(msg);
        const fallbackUrl = await blobToDataUrl(blob).catch(() => '');
        updateResponse(block.id, {
          audioBlobRef: fallbackUrl,
          questionId: activePromptItem?.id,
          audioDurationSec: Math.max(5, durationSec),
          promptSnapshot: activePromptText,
          textOrTranscript: transcript || '',
        });
        setRecordingState('done');
      }
    },
    [activePromptItem, activePromptText, block.id, transcript, updateResponse]
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
      previousDraft: timestampedTranscript || transcript || response?.previousDraft,
      attemptCount: (response?.attemptCount ?? 1) + 1,
      audioBlobRef: undefined,
      textOrTranscript: '',
      timestampedTranscript: '',
      fillerCount: undefined,
      wpm: undefined,
    });
  };

  const handleSelectPrompt = (idx: number) => {
    const chosen = prompts[idx];
    if (!chosen) return;
    setSelectedPromptIdx(idx);
    updateResponse(block.id, {
      promptSnapshot: chosen.prompt,
      questionId: chosen.id,
      questionType: chosen.type,
    });
  };

  const handleNextUnseenPrompt = () => {
    const nextUnseen = prompts.findIndex(
      (q, i) => i !== selectedPromptIdx && !completedIds.has(q.id)
    );
    if (nextUnseen >= 0) {
      handleSelectPrompt(nextUnseen);
    } else if (prompts.length > 1) {
      handleSelectPrompt((selectedPromptIdx + 1) % prompts.length);
    }
  };

  const verifiedDuration =
    response?.audioDurationSec || recordingSeconds || response?.timeSpentSec || 60;
  const speechStats = analyzeSpeechTranscript(transcript, verifiedDuration);
  const unseenLeft = prompts.filter((q) => !completedIds.has(q.id)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
        <div className="flex items-center gap-2">
          <WhisperLiveIndicator />
          <span className="text-xs font-bold text-primary-800 bg-primary-50 px-2.5 py-1 rounded-full">
            ✨ {unseenLeft} Unseen Prompts Left
          </span>
        </div>

        {prompts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedPromptIdx}
              onChange={(e) => handleSelectPrompt(Number(e.target.value))}
              className="text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 max-w-xs"
            >
              {prompts.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.dayNumber ? `Day ${p.dayNumber}: ` : `#${idx + 1}: `}
                    {p.sourceAttribution?.replace('DET Speaking Bank — ', '') ||
                      p.prompt.slice(0, 42)}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={handleNextUnseenPrompt}
              className="text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 px-3 py-1.5 rounded-lg cursor-pointer"
            >
              Next Unseen →
            </button>
          </div>
        )}
      </div>

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-bold text-primary-800 uppercase tracking-wide">
            {activePromptItem?.sourceAttribution || 'DET Speaking Sample'}
            {activePromptItem?.dayNumber ? ` • Plan Day ${activePromptItem.dayNumber}` : ''}
          </p>
          <span className="text-xs text-primary-700 font-semibold">
            Target: 60–90s • 130–150 WPM
          </span>
        </div>
        <p className="text-base text-slate-900 leading-relaxed font-medium">{activePromptText}</p>
      </div>

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
              Recording Verbatim Audio (Word Timestamps Active)...
            </span>
            <span className="font-mono text-sm text-white">{recordingSeconds}s recorded</span>
          </div>
        </div>
      )}

      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 text-center space-y-2">
          <div className="inline-block w-6 h-6 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-semibold text-accent-800">
            Transcribing via Local Faster-Whisper (RTX 3050)...
          </p>
          <p className="text-xs text-accent-600">
            Computing exact segment timestamps & [PAUSE] markers for DET fluency evaluation.
          </p>
        </div>
      )}

      <div className="flex flex-col items-center gap-4">
        {recordingState === 'idle' && !response?.audioBlobRef && (
          <button
            type="button"
            onClick={handleStart}
            className="px-8 py-4 rounded-2xl bg-red-500 hover:bg-red-600 text-white font-bold text-base flex items-center gap-3 shadow-lg transition-all hover:scale-105 cursor-pointer"
          >
            <span className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
            Start Speaking Recording
          </button>
        )}

        {recordingState === 'recording' && (
          communicativePressure && blockTimeRemaining > 5 ? (
            <div className="px-6 py-3 rounded-xl bg-red-950 text-red-200 text-xs font-bold border border-red-800">
              Communicative Pressure Mode Active: Keep speaking until the timer ends ({blockTimeRemaining}s remaining)
            </div>
          ) : (
            <button
              type="button"
              onClick={handleStop}
              className="px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-base flex items-center gap-3 shadow-lg cursor-pointer"
            >
              <span className="w-3.5 h-3.5 rounded-sm bg-red-500" />
              Stop & Transcribe Now ({recordingSeconds}s)
            </button>
          )
        )}
      </div>

      {response?.audioBlobRef && recordingState !== 'recording' && recordingState !== 'transcribing' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-green-700">
              ✓ Audio Captured ({verifiedDuration}s verified duration)
            </span>
            <button
              type="button"
              onClick={handleRerecord}
              className="px-3.5 py-1.5 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
            >
              ↺ Re-record Immediately (Fix Pauses & Fillers)
            </button>
          </div>

          <audio controls src={response.audioBlobRef} className="w-full h-10" />

          <div className="grid grid-cols-4 gap-3 pt-1">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Verified Duration</p>
              <p className="text-lg font-bold text-slate-900">{verifiedDuration}s</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Word Count</p>
              <p className="text-lg font-bold text-slate-900">{speechStats.wordCount}</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Speaking Pace</p>
              <p
                className={`text-lg font-bold ${
                  speechStats.wpm >= 115 && speechStats.wpm <= 165
                    ? 'text-green-600'
                    : 'text-amber-600'
                }`}
              >
                {speechStats.wpm} WPM
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Fillers ("uh/um")</p>
              <p
                className={`text-lg font-bold ${
                  speechStats.fillerCount <= 2 ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {speechStats.fillerCount}
              </p>
            </div>
          </div>

          {timestampedTranscript && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Faster-Whisper Timestamped Acoustic Log (Sent to Gemini):
              </label>
              <pre className="w-full p-3 text-xs font-mono text-green-300 bg-slate-900 rounded-lg overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {timestampedTranscript}
              </pre>
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
