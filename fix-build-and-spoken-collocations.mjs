// fix-build-and-spoken-collocations.mjs
// 1. Fixes TS2322 build error in TransitionOverlay.tsx (accepts both `count` and `countdown`)
// 2. Upgrades DictoglossBlock.tsx + database.ts so Dictogloss plays REAL human audio via stt-backend
// 3. Adds "Spoken Collocation Mode" (Voice Recording + Whisper STT + Spoken AI Evaluation) to VocabWritingBlock.tsx
// Run from project root: node fix-build-and-spoken-collocations.mjs

import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. TRANSITION OVERLAY: Accept both `count` and `countdown` (Fixes TS2322)
  // =========================================================================
  'src/components/exam/TransitionOverlay.tsx': `import { useSessionStore } from '../../stores/sessionStore';

export interface TransitionOverlayProps {
  count?: number;
  countdown?: number;
  nextBlockName: string;
}

export function TransitionOverlay({
  count,
  countdown,
  nextBlockName,
}: TransitionOverlayProps) {
  const skipTransition = useSessionStore((s) => s.skipTransition);
  const displayValue = count ?? countdown ?? 3;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center text-white p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-primary-400 mb-2">
        Up Next
      </p>
      <h2 className="text-2xl font-bold mb-6 text-center">{nextBlockName}</h2>
      <div className="w-24 h-24 rounded-full border-4 border-primary-400 flex items-center justify-center text-5xl font-extrabold font-mono animate-pulse mb-8">
        {displayValue}
      </div>
      <button
        type="button"
        onClick={skipTransition}
        className="px-5 py-2.5 bg-white/10 hover:bg-white/20 border border-white/25 rounded-xl text-xs font-bold text-white cursor-pointer transition-colors"
      >
        Skip Countdown & Start Block Now →
      </button>
    </div>
  );
}
`,

  // =========================================================================
  // 2. VOCAB & COLLOCATION BLOCK: Written Mode + NEW Spoken Voice Mode!
  // =========================================================================
  'src/components/exam/blocks/VocabWritingBlock.tsx': `import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useSessionStore, selectBlockTimeRemaining } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import { initSRS, reviewItem } from '../../../utils/srs';
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

function formatPromptWithChunks(
  q: QuestionBankItem | null,
  fallback: string,
  mode: 'written' | 'spoken'
): string {
  const basePrompt = q ? q.prompt : fallback;
  const chunks = q?.targetChunks ?? [];
  const modeHeader =
    mode === 'spoken'
      ? '[SPOKEN COLLOCATION APPLICATION DRILL — Student recorded this response aloud by voice. Evaluate as SPOKEN oral production (fluency, pacing, spoken grammar) AND verify natural spoken use of the 4 target collocation chunks]'
      : '[WRITTEN COLLOCATION PRECISION DRILL — Evaluate written academic syntax, cohesion, and natural use of the 4 target collocation chunks]';

  if (chunks.length === 0) return \`\${modeHeader}\\n\${basePrompt}\`;
  return \`\${modeHeader}\\nTask: \${basePrompt}\\nRequired 4 Collocation Chunks: \${chunks
    .map((c) => \`"\${c}"\`)
    .join(', ')}\`;
}

export function VocabWritingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);

  // Default to 'spoken' if block name mentions Application or Speaking, otherwise 'written'
  const defaultInputMode: 'written' | 'spoken' =
    block.name.toLowerCase().includes('application') ||
    block.name.toLowerCase().includes('spoken')
      ? 'spoken'
      : 'written';

  const [inputMode, setInputMode] = useState<'written' | 'spoken'>(defaultInputMode);
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [gradedMessage, setGradedMessage] = useState<string | null>(null);

  // Spoken mode audio recording states
  const [recordingState, setRecordingState] = useState<
    'idle' | 'recording' | 'transcribing' | 'done'
  >('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(new Array(28).fill(0));
  const [recError, setRecError] = useState<string | null>(null);

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const animFrameRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const timestampedTranscript = response?.timestampedTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  const loadCollocationSets = useCallback(async () => {
    const { selected, completedIds: doneSet } = await getAdaptiveQuestions({
      skill: 'writing',
      questionType: 'write-about-photo',
      limit: 30,
    });

    const withChunks = selected.filter((q) => (q.targetChunks?.length ?? 0) > 0);
    const list = withChunks.length > 0 ? withChunks : selected;

    setQuestions(list);
    setCompletedIds(new Set(doneSet));

    if (list.length > 0) {
      let targetIndex = 0;
      if (block.questionSetId) {
        const pinnedIdx = list.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) targetIndex = pinnedIdx;
      } else if (response?.questionId) {
        const existingIdx = list.findIndex((q) => q.id === response.questionId);
        if (existingIdx >= 0) targetIndex = existingIdx;
      } else {
        const firstUnseen = list.findIndex((q) => !doneSet.has(q.id));
        if (firstUnseen >= 0) targetIndex = firstUnseen;
      }

      setSelectedIdx(targetIndex);
      const chosen = list[targetIndex];
      if (chosen && !response?.questionId) {
        updateResponse(block.id, {
          questionId: chosen.id,
          questionType:
            inputMode === 'spoken' ? 'spoken-collocation-drill' : chosen.type,
          promptSnapshot: formatPromptWithChunks(chosen, block.instructions, inputMode),
        });
      }
    }
  }, [
    block.id,
    block.instructions,
    block.questionSetId,
    inputMode,
    response?.questionId,
    updateResponse,
  ]);

  useEffect(() => {
    void loadCollocationSets();
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, [loadCollocationSets]);

  const activeQuestion = questions[selectedIdx] ?? null;
  const activeChunks = useMemo(
    () => activeQuestion?.targetChunks ?? [],
    [activeQuestion]
  );

  // Check which of the 4 target chunks appear in the written text OR spoken transcript
  const usedChunkMap = useMemo(() => {
    const lowerText = text.toLowerCase();
    const map: Record<string, boolean> = {};
    for (const chunk of activeChunks) {
      map[chunk] = lowerText.includes(chunk.toLowerCase());
    }
    return map;
  }, [activeChunks, text]);

  const usedChunksCount = useMemo(
    () => activeChunks.filter((c) => usedChunkMap[c]).length,
    [activeChunks, usedChunkMap]
  );

  const handleSwitchInputMode = (nextMode: 'written' | 'spoken') => {
    setInputMode(nextMode);
    setRecError(null);
    updateResponse(block.id, {
      questionType:
        nextMode === 'spoken'
          ? 'spoken-collocation-drill'
          : activeQuestion?.type ?? 'write-about-photo',
      promptSnapshot: formatPromptWithChunks(
        activeQuestion,
        block.instructions,
        nextMode
      ),
    });
  };

  const handleSelectQuestionIndex = (nextIdx: number) => {
    const nextQ = questions[nextIdx];
    if (!nextQ) return;
    setSelectedIdx(nextIdx);
    updateResponse(block.id, {
      questionId: nextQ.id,
      questionType:
        inputMode === 'spoken' ? 'spoken-collocation-drill' : nextQ.type,
      promptSnapshot: formatPromptWithChunks(nextQ, block.instructions, inputMode),
    });
  };

  const handleJumpToNextUnseen = async () => {
    if (activeQuestion && wordCount >= 25) {
      await markQuestionCompleted(activeQuestion.id);
      setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
    }
    const nextUnseenIdx = questions.findIndex(
      (q, i) => i !== selectedIdx && !completedIds.has(q.id)
    );
    if (nextUnseenIdx >= 0) {
      handleSelectQuestionIndex(nextUnseenIdx);
    } else if (questions.length > 1) {
      handleSelectQuestionIndex((selectedIdx + 1) % questions.length);
    }
  };

  // =========================================================================
  // SPOKEN COLLOCATION MODE: Recording & Local Faster-Whisper Transcription
  // =========================================================================
  const animateWaveform = useCallback(() => {
    const recorder = recorderRef.current;
    const analyser = recorder?.getAnalyser();
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const buckets = 28;
    const step = Math.floor(data.length / buckets);
    const newLevels = Array.from({ length: buckets }, (_, i) =>
      Math.round((data[i * step] / 255) * 100)
    );
    setLevels(newLevels);
    animFrameRef.current = requestAnimationFrame(animateWaveform);
  }, []);

  const handleStartSpeaking = useCallback(async () => {
    setRecError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setRecError('Microphone permission denied. Please allow microphone access.');
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
      setRecError(
        \`Could not start recording: \${e instanceof Error ? e.message : 'Unknown error'}\`
      );
    }
  }, [animateWaveform]);

  const handleStopSpeaking = useCallback(async () => {
    cancelAnimationFrame(animFrameRef.current);
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setLevels(new Array(28).fill(0));
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;

    setRecordingState('transcribing');
    setRecError(null);

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
      const actualDuration =
        result.durationSec ?? Math.max(5, recordDurationRef.current);
      const stats = analyzeSpeechTranscript(result.text, actualDuration);

      if (activeQuestion?.id) {
        void markQuestionCompleted(activeQuestion.id);
        setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
      }

      updateResponse(block.id, {
        audioBlobRef: dataUrl,
        questionId: activeQuestion?.id,
        questionType: 'spoken-collocation-drill',
        textOrTranscript: result.text || '[No speech detected in recording]',
        timestampedTranscript: result.timestampedText || result.text,
        audioDurationSec: actualDuration,
        promptSnapshot: formatPromptWithChunks(
          activeQuestion,
          block.instructions,
          'spoken'
        ),
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setRecError(
        err instanceof Error ? err.message : 'Spoken collocation transcription failed'
      );
      setRecordingState('idle');
    }
  }, [activeQuestion, block.id, block.instructions, updateResponse]);

  useEffect(() => {
    if (recordingState === 'recording' && blockTimeRemaining <= 1) {
      void handleStopSpeaking();
    }
  }, [blockTimeRemaining, recordingState, handleStopSpeaking]);

  const handleRerecordSpoken = () => {
    setRecordingState('idle');
    setRecordingSeconds(0);
    updateResponse(block.id, {
      previousDraft: timestampedTranscript || text || response?.previousDraft,
      attemptCount: (response?.attemptCount ?? 1) + 1,
      audioBlobRef: undefined,
      textOrTranscript: '',
      timestampedTranscript: '',
      fillerCount: undefined,
      wpm: undefined,
    });
  };

  // =========================================================================
  // WRITTEN COLLOCATION MODE: Textarea Handler
  // =========================================================================
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
      updateResponse(block.id, {
        textOrTranscript: val,
        promptSnapshot: formatPromptWithChunks(
          activeQuestion,
          block.instructions,
          inputMode
        ),
        questionId: activeQuestion?.id,
        questionType:
          inputMode === 'spoken'
            ? 'spoken-collocation-drill'
            : activeQuestion?.type ?? 'write-about-photo',
      });
      if (wc >= 35 && activeQuestion && !completedIds.has(activeQuestion.id)) {
        void markQuestionCompleted(activeQuestion.id);
        setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
      }
    },
    [
      activeQuestion,
      block.id,
      block.instructions,
      completedIds,
      inputMode,
      updateResponse,
    ]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const handleRateSRS = async (quality: number, label: string) => {
    if (!activeQuestion) return;
    const currentSrs = activeQuestion.srs ?? initSRS();
    const updatedSrs = reviewItem(currentSrs, quality);
    const updatedItem: QuestionBankItem = {
      ...activeQuestion,
      srs: updatedSrs,
      completedAt: new Date().toISOString(),
      timesCompleted: (activeQuestion.timesCompleted ?? 0) + 1,
    };
    await db.questionBank.put(updatedItem);
    setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
    setQuestions((prev) =>
      prev.map((q, idx) => (idx === selectedIdx ? updatedItem : q))
    );
    setGradedMessage(
      \`✓ Marked Done & SRS Updated (\${label}): Next review in \${updatedSrs.intervalDays}d\`
    );
    setTimeout(() => setGradedMessage(null), 3500);
  };

  const unseenRemaining = questions.filter((q) => !completedIds.has(q.id)).length;
  const verifiedSpokenDuration =
    response?.audioDurationSec || recordingSeconds || response?.timeSpentSec || 60;
  const speechStats = analyzeSpeechTranscript(text, verifiedSpokenDuration);

  return (
    <div className="space-y-4">
      {/* Top Bar: Mode Switcher (Written vs Spoken Voice) + Unseen Selector */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-100 p-1 border border-slate-200">
            <button
              type="button"
              onClick={() => handleSwitchInputMode('written')}
              className={\`px-3 py-1.5 text-xs font-bold rounded-md cursor-pointer transition-all \${
                inputMode === 'written'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }\`}
            >
              ✍️ Written Collocation Drill
            </button>
            <button
              type="button"
              onClick={() => handleSwitchInputMode('spoken')}
              className={\`px-3 py-1.5 text-xs font-bold rounded-md cursor-pointer transition-all \${
                inputMode === 'spoken'
                  ? 'bg-red-600 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }\`}
            >
              🎙️ Spoken Collocation Drill (Record Voice)
            </button>
          </div>

          {inputMode === 'spoken' && <WhisperLiveIndicator />}
        </div>

        {questions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-primary-100 text-primary-800">
              ✨ {unseenRemaining}/{questions.length} Unseen
            </span>

            <select
              value={selectedIdx}
              onChange={(e) => handleSelectQuestionIndex(Number(e.target.value))}
              className="text-xs font-semibold border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 bg-slate-50 max-w-xs"
            >
              {questions.map((q, idx) => {
                const isDone = completedIds.has(q.id);
                return (
                  <option key={q.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {q.dayNumber ? \`Day \${q.dayNumber}: \` : \`Set #\${idx + 1}: \`}
                    {q.sourceAttribution?.replace('DET C1/C2 Collocation Bank — ', '') ||
                      q.prompt.slice(0, 44)}
                  </option>
                );
              })}
            </select>

            <button
              type="button"
              onClick={handleJumpToNextUnseen}
              className="px-3 py-1.5 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Next Unseen Set →
            </button>
          </div>
        )}
      </div>

      {gradedMessage && (
        <div className="text-xs font-semibold text-green-800 bg-green-50 border border-green-200 rounded-lg px-3.5 py-2">
          {gradedMessage}
        </div>
      )}

      {/* Prompt & Dynamic 4-Collocation Chunks Card */}
      <div className="bg-accent-50/80 border-2 border-accent-200 rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-accent-800 uppercase tracking-wider bg-accent-100 px-2.5 py-0.5 rounded">
              {inputMode === 'spoken'
                ? '🎙️ Spoken Collocation Application (Evaluated as Speech)'
                : '✍️ Written Collocation Precision'}
            </span>
            {activeQuestion?.dayNumber && (
              <span className="text-xs font-mono font-bold text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                Plan Day {activeQuestion.dayNumber}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {activeChunks.length > 0 && (
              <span
                className={\`text-xs font-bold px-2.5 py-1 rounded-full \${
                  usedChunksCount === activeChunks.length
                    ? 'bg-green-600 text-white'
                    : 'bg-white text-accent-800 border border-accent-300'
                }\`}
              >
                {inputMode === 'spoken' ? 'Spoken Chunks Detected' : 'Written Chunks Used'}:{' '}
                {usedChunksCount} / {activeChunks.length}
              </span>
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => handleRateSRS(2, 'Again')}
                className="px-2 py-0.5 text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200 rounded cursor-pointer"
              >
                SRS: Again
              </button>
              <button
                type="button"
                onClick={() => handleRateSRS(5, 'Easy')}
                className="px-2 py-0.5 text-[11px] font-semibold bg-green-50 text-green-700 border border-green-200 rounded cursor-pointer"
              >
                SRS: Easy
              </button>
            </div>
          </div>
        </div>

        <p className="text-base text-slate-900 leading-relaxed font-semibold">
          {inputMode === 'spoken'
            ? (activeQuestion?.prompt || block.instructions).replace(
                /^Write an? [^ ]+ paragraph/i,
                'Speak aloud for 60–90 seconds'
              )
            : activeQuestion?.prompt || block.instructions}
        </p>

        {/* Dynamic Collocation Pills */}
        {activeChunks.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-bold text-slate-600">
              {inputMode === 'spoken'
                ? 'Target Multi-Word Collocation Chunks (say all 4 phrases naturally while speaking — Faster-Whisper will check them off automatically):'
                : 'Target Multi-Word Collocation Chunks (type each phrase naturally in your paragraph below):'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {activeChunks.map((chunk, idx) => {
                const isUsed = Boolean(usedChunkMap[chunk]);
                return (
                  <div
                    key={\`\${activeQuestion?.id}-chunk-\${idx}\`}
                    className={\`flex items-center justify-between px-3.5 py-2 rounded-xl border-2 text-xs font-mono font-bold transition-all \${
                      isUsed
                        ? 'bg-green-100 border-green-500 text-green-900 shadow-2xs'
                        : 'bg-white border-accent-300 text-slate-800'
                    }\`}
                  >
                    <span>
                      {idx + 1}. "{chunk}"
                    </span>
                    <span
                      className={\`text-[11px] font-sans font-bold px-2 py-0.5 rounded \${
                        isUsed
                          ? 'bg-green-600 text-white'
                          : 'bg-slate-100 text-slate-500'
                      }\`}
                    >
                      {isUsed
                        ? inputMode === 'spoken'
                          ? '✓ Spoken!'
                          : '✓ Used'
                        : 'Pending'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeQuestion?.sampleAnswer && (
          <details className="pt-1 text-xs text-slate-700">
            <summary className="cursor-pointer font-bold text-accent-800 hover:underline">
              Show Reference 150-Band Model Response
            </summary>
            <p className="mt-2 p-3 bg-white rounded-xl border border-accent-200 italic leading-relaxed">
              {activeQuestion.sampleAnswer}
            </p>
          </details>
        )}
      </div>

      {/* =================================================================== */}
      {/* INPUT AREA: SPOKEN VOICE MODE VS WRITTEN TEXTAREA MODE              */}
      {/* =================================================================== */}
      {inputMode === 'spoken' ? (
        <div className="space-y-4">
          {recordingState === 'recording' && (
            <div className="bg-slate-900 rounded-xl p-5 shadow-inner">
              <div className="flex items-end justify-center gap-1 h-20">
                {levels.map((level, i) => (
                  <div
                    key={i}
                    className="w-2 rounded-sm bg-red-400 transition-all duration-75"
                    style={{ height: \`\${Math.max(6, level)}%\` }}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-xs text-slate-300 mt-3 pt-2 border-t border-slate-800">
                <span className="flex items-center gap-2 text-red-400 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  Recording Spoken Collocation Drill (Weave all 4 chunks into your speech)...
                </span>
                <span className="font-mono text-sm text-white">
                  {recordingSeconds}s recorded
                </span>
              </div>
            </div>
          )}

          {recordingState === 'transcribing' && (
            <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 text-center space-y-2">
              <div className="inline-block w-6 h-6 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-semibold text-accent-800">
                Transcribing Spoken Collocations via Faster-Whisper (RTX 3050)...
              </p>
              <p className="text-xs text-accent-600">
                Checking your spoken transcript for the 4 target collocation chunks and computing WPM & pause fluency.
              </p>
            </div>
          )}

          <div className="flex justify-center">
            {recordingState === 'idle' && !response?.audioBlobRef && (
              <button
                type="button"
                onClick={handleStartSpeaking}
                className="px-8 py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm flex items-center gap-3 shadow-lg transition-all hover:scale-105 cursor-pointer"
              >
                <span className="w-3.5 h-3.5 rounded-full bg-white animate-pulse" />
                🎙️ Start Recording Spoken Collocation Drill
              </button>
            )}

            {recordingState === 'recording' && (
              <button
                type="button"
                onClick={handleStopSpeaking}
                className="px-8 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm flex items-center gap-3 shadow-lg cursor-pointer"
              >
                <span className="w-3.5 h-3.5 rounded-sm bg-red-500" />
                Stop & Transcribe Speech ({recordingSeconds}s)
              </button>
            )}
          </div>

          {response?.audioBlobRef &&
            recordingState !== 'recording' &&
            recordingState !== 'transcribing' && (
              <div className="bg-white border-2 border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold text-green-700">
                    ✓ Spoken Collocation Audio Captured ({verifiedSpokenDuration}s) •{' '}
                    {usedChunksCount}/{activeChunks.length} Chunks Spoken
                  </span>
                  <button
                    type="button"
                    onClick={handleRerecordSpoken}
                    className="px-3.5 py-1.5 text-xs font-bold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
                  >
                    ↺ Re-record Speech
                  </button>
                </div>

                <audio controls src={response.audioBlobRef} className="w-full h-10" />

                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-xs text-slate-500">Chunks Spoken</p>
                    <p className="text-lg font-bold text-primary-700">
                      {usedChunksCount} / {activeChunks.length}
                    </p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-xs text-slate-500">Speaking Pace</p>
                    <p className="text-lg font-bold text-slate-900">
                      {speechStats.wpm} WPM
                    </p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-xs text-slate-500">Fillers ("uh/um")</p>
                    <p className="text-lg font-bold text-slate-900">
                      {speechStats.fillerCount}
                    </p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <p className="text-xs text-slate-500">Spoken Words</p>
                    <p className="text-lg font-bold text-slate-900">
                      {speechStats.wordCount}
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Verbatim Spoken Transcript (Editable if Whisper misheard a word):
                  </label>
                  <textarea
                    value={text}
                    onChange={handleChange}
                    rows={3}
                    className="w-full p-3 text-sm text-slate-800 bg-slate-50 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
            )}

          {recError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
              {recError}
            </div>
          )}
        </div>
      ) : (
        <div>
          <textarea
            value={text}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            placeholder="Write your cohesive academic paragraph here incorporating all 4 target collocation chunks..."
            className="w-full min-h-[250px] p-4 text-base text-slate-800 bg-white border-2 border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-accent-500 leading-relaxed"
            spellCheck
            autoFocus
          />
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-slate-500">
            <span>
              Aim for 65–110 words with complex subordination (whereas, although, consequently)
            </span>
            <span className={wordCount >= 65 ? 'text-green-600 font-bold' : 'font-mono'}>
              {wordCount} {wordCount === 1 ? 'word' : 'words'}{' '}
              {wordCount >= 65 ? '✓' : '/ 65+'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 3. DICTOGLOSS BLOCK: Auto-Downloads Real Human Audio via stt-backend!
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

// Fallback curated TED / Academic YouTube sources so EVERY Dictogloss passage
// can play a real human voice via stt-backend even if created before youtubeSource was added!
const DEFAULT_DICTOGLOSS_YOUTUBE_MAP: Record<
  string,
  { clipKey: string; url: string; startTime: string; endTime: string; speaker: string }
> = {
  'dg-sla-chunking': {
    clipKey: 'yt_boroditsky_duocon',
    url: 'https://www.youtube.com/watch?v=kBEBq2eP19k',
    startTime: '00:30',
    endTime: '01:35',
    speaker: 'Prof. Lera Boroditsky (Duocon — Language & Cognition)',
  },
  'dg-det-architectural-acoustics': {
    clipKey: 'yt_treasure_speech',
    url: 'https://www.youtube.com/watch?v=eIho2S0ZahI',
    startTime: '00:20',
    endTime: '01:25',
    speaker: 'Julian Treasure (TED — Sound & Acoustics)',
  },
  'dg-det-sleep-consolidation': {
    clipKey: 'yt_laraboyd_neuro',
    url: 'https://www.youtube.com/watch?v=LNHBMFCzznE',
    startTime: '00:30',
    endTime: '01:35',
    speaker: 'Dr. Lara Boyd (TEDx — Brain & Memory Consolidation)',
  },
  'dg-conversation-brain-capital': {
    clipKey: 'yt_boroditsky_ted',
    url: 'https://www.youtube.com/watch?v=RKK7wGAYP6k',
    startTime: '00:20',
    endTime: '01:25',
    speaker: 'Prof. Lera Boroditsky (TED — Cognitive Diversity)',
  },
};

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [phase, setPhase] = useState<'listen' | 'reconstruct'>('listen');
  const [playCount, setPlayCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [downloadingHumanAudio, setDownloadingHumanAudio] = useState(false);
  const [audioStatusMsg, setAudioStatusMsg] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const response = draftResponses[block.id];
  const fragmentNotes = response?.fragmentNotes ?? '';
  const reconstructedText = response?.textOrTranscript ?? '';

  useEffect(() => {
    const loadDictoglossItems = async () => {
      const [all, doneSet] = await Promise.all([
        db.questionBank.toArray(),
        getCompletedQuestionIds(),
      ]);
      setCompletedIds(doneSet);

      let manifest: Record<string, { audioUrl: string; text: string }> = {};
      let backendOnline = false;
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
        if (res.ok) {
          backendOnline = true;
          manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
        }
      } catch {
        backendOnline = false;
      }

      const hydrated: QuestionBankItem[] = [];
      for (const q of all) {
        const fallbackYt = DEFAULT_DICTOGLOSS_YOUTUBE_MAP[q.id];
        const ytSource = q.youtubeSource ?? fallbackYt;
        const clipKey = ytSource?.clipKey;

        if (clipKey && manifest[clipKey]) {
          const cached = manifest[clipKey];
          const verbatim = cached.text?.trim() || q.sourceAudioText || q.prompt;
          const upgraded: QuestionBankItem = {
            ...q,
            youtubeSource: ytSource,
            audioUrl: normalizeAudioUrl(cached.audioUrl),
            sourceAudioText: verbatim,
            prompt: verbatim,
          };
          await db.questionBank.put(upgraded);
          hydrated.push(upgraded);
        } else {
          hydrated.push({
            ...q,
            youtubeSource: ytSource,
            audioUrl:
              backendOnline && q.audioUrl && !clipKey
                ? normalizeAudioUrl(q.audioUrl)
                : undefined,
          });
        }
      }

      // Include all Dictogloss items AND any downloaded/linked Human Audio talks
      const items = hydrated.filter(
        (q) =>
          q.tags.includes('dictogloss') ||
          q.skill === 'listening' ||
          Boolean(q.audioUrl) ||
          Boolean(q.youtubeSource)
      );

      items.sort((a, b) => {
        // Prioritize items with local human MP3 ready first, then unseen items
        const aHuman = a.audioUrl ? 2 : a.youtubeSource ? 1 : 0;
        const bHuman = b.audioUrl ? 2 : b.youtubeSource ? 1 : 0;
        if (aHuman !== bHuman) return bHuman - aHuman;
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        return aDone - bDone;
      });

      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
      } else {
        const firstWithHumanAudio = finalList.findIndex(
          (q) => Boolean(q.audioUrl) && !doneSet.has(q.id)
        );
        const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
        setSelectedIdx(
          firstWithHumanAudio >= 0
            ? firstWithHumanAudio
            : firstUnseen >= 0
            ? firstUnseen
            : 0
        );
      }
    };
    void loadDictoglossItems();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [block.questionSetId]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const ytSource =
    currentItem?.youtubeSource ??
    (currentItem ? DEFAULT_DICTOGLOSS_YOUTUBE_MAP[currentItem.id] : undefined);
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research indicates that grammatical accuracy emerges naturally when learners internalize multi-word collocation chunks as unified perceptual units rather than assembling individual words through explicit grammatical rules.';

  // Downloads real human audio from stt-backend on demand and plays it immediately
  const handleDownloadAndPlayHumanAudio = useCallback(async () => {
    if (!currentItem || !ytSource) return false;
    setDownloadingHumanAudio(true);
    setAudioStatusMsg(
      \`Fetching real human voice (\${ytSource.speaker}) via stt-backend...\`
    );
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
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
        throw new Error(\`HTTP \${res.status}\`);
      }
      const data = (await res.json()) as { audioUrl: string; text: string };
      const cleanUrl = normalizeAudioUrl(data.audioUrl);
      const verbatim = data.text?.trim() || currentItem.sourceAudioText || currentItem.prompt;
      const updatedItem: QuestionBankItem = {
        ...currentItem,
        youtubeSource: ytSource,
        audioUrl: cleanUrl,
        sourceAudioText: verbatim,
        prompt: verbatim,
      };
      await db.questionBank.put(updatedItem);
      setPassages((prev) =>
        prev.map((p, idx) => (idx === selectedIdx ? updatedItem : p))
      );
      setAudioStatusMsg('✓ Real Human Audio ready! Playing now...');
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.src = cleanUrl;
          audioRef.current.currentTime = 0;
          void audioRef.current.play();
          setIsPlaying(true);
        }
      }, 150);
      return true;
    } catch {
      setAudioStatusMsg(
        '⚠️ Local stt-backend (port 8000) is offline or clip not cached yet — falling back to Browser TTS.'
      );
      return false;
    } finally {
      setDownloadingHumanAudio(false);
    }
  }, [currentItem, selectedIdx, ytSource]);

  const handlePlayPassage = useCallback(async () => {
    // 1. If Real Human MP3 is already on disk, play it directly!
    if (humanAudioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setIsPlaying(true);
      return;
    }

    // 2. If a curated YouTube human talk is linked, auto-fetch the real human voice from stt-backend!
    if (ytSource) {
      const ok = await handleDownloadAndPlayHumanAudio();
      if (ok) return;
    }

    // 3. Only use Browser TTS if stt-backend is unreachable
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourcePassage);
    utterance.lang = 'en-US';
    utterance.rate = 0.98;
    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => {
      setIsPlaying(false);
      setPlayCount((c) => c + 1);
    };
    window.speechSynthesis.speak(utterance);
  }, [
    handleDownloadAndPlayHumanAudio,
    humanAudioUrl,
    sourcePassage,
    ytSource,
  ]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const words = val.trim().split(/\\s+/).filter(Boolean);
    if (words.length > 25) return;
    updateResponse(block.id, {
      fragmentNotes: val,
      promptSnapshot: sourcePassage,
      questionId: currentItem?.id,
    });
  };

  const handleReconstructionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\\s+/).length : 0;
  const reconWordCount = reconstructedText.trim()
    ? reconstructedText.trim().split(/\\s+/).length
    : 0;

  return (
    <div className="space-y-5">
      {/* Step-by-Step How-To Guide Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-4 space-y-2.5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <WhisperLiveIndicator />
            <span
              className={\`text-xs font-bold px-2.5 py-0.5 rounded-full \${
                humanAudioUrl
                  ? 'bg-green-500 text-slate-950'
                  : 'bg-primary-500/20 text-primary-300 border border-primary-400/40'
              }\`}
            >
              {humanAudioUrl
                ? '🎙️ Real Human MP3 Loaded & Synced'
                : ytSource
                ? \`🎬 Human Talk Linked: \${ytSource.speaker}\`
                : '🔊 Audio Track'}
            </span>
          </div>

          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setPhase('listen');
                setAudioStatusMsg(null);
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1 text-xs font-semibold text-slate-900 bg-white rounded-lg cursor-pointer max-w-[260px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                const hasMp3 = Boolean(p.audioUrl);
                return (
                  <option key={p.id} value={idx}>
                    {hasMp3 ? '🎙️ [Human MP3] ' : '🎬 [TED Clip] '}
                    {isDone ? '✓ ' : '✨ '}
                    {p.sourceAttribution || p.prompt.slice(0, 32)}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'listen' && playCount === 0
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 1: 1st Listen (Hands Off)</strong>
            Click Play and listen to the human speaker to grasp the main thesis and cause-and-effect links.
          </div>
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'listen' && playCount >= 1
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 2: 2nd Listen (Fragment Notes)</strong>
            Play a second time and type only 2–4 word shorthand keywords (max 25 words).
          </div>
          <div
            className={\`p-2.5 rounded-xl border \${
              phase === 'reconstruct'
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }\`}
          >
            <strong className="text-primary-300 block">Step 3: Reconstruct Meaning</strong>
            Rebuild the full meaning in your own C1/C2 sentences (not word-for-word memorization).
          </div>
        </div>
      </div>

      {/* Phase Toggle Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700">
          Current Stage:{' '}
          {phase === 'listen'
            ? 'Phase 1 — Listening to Human Speaker & Taking Shorthand Notes'
            : 'Phase 2 — Meaning Reconstruction'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhase('listen')}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'listen' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            1. Listen & Fragment Notes
          </button>
          <button
            type="button"
            onClick={() => {
              if (audioRef.current) audioRef.current.pause();
              if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              setIsPlaying(false);
              setPhase('reconstruct');
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'reconstruct' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            2. Reconstruct Meaning →
          </button>
        </div>
      </div>

      {/* Hidden HTML5 Audio Element for Real Human MP3 Playback */}
      <audio
        ref={audioRef}
        src={humanAudioUrl || undefined}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setPlayCount((c) => c + 1);
        }}
        className="hidden"
      />

      {phase === 'listen' ? (
        <div className="bg-accent-50 border-2 border-accent-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs font-bold text-accent-900">
                Audio Listens Used: {playCount} / 2 Recommended •{' '}
                {humanAudioUrl
                  ? '🎙️ Real Human Audio Active'
                  : ytSource
                  ? \`🎬 Auto-Loads Real Human Voice (\${ytSource.speaker})\`
                  : 'Browser Voice'}
              </span>
              <p className="text-xs text-slate-600">
                The transcript is hidden during listening to train your working memory.
              </p>
              {audioStatusMsg && (
                <p className="text-xs font-semibold text-primary-800 mt-1">
                  {audioStatusMsg}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isPlaying && (
                <button
                  type="button"
                  onClick={() => {
                    if (audioRef.current) audioRef.current.pause();
                    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                      window.speechSynthesis.cancel();
                    }
                    setIsPlaying(false);
                  }}
                  className="px-4 py-3 bg-slate-900 text-white text-xs font-bold rounded-xl cursor-pointer"
                >
                  ⏹ Stop Audio
                </button>
              )}
              <button
                type="button"
                onClick={() => void handlePlayPassage()}
                disabled={isPlaying || downloadingHumanAudio}
                className="px-5 py-3 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {downloadingHumanAudio
                  ? '⏳ Loading Real Human Voice...'
                  : isPlaying
                  ? '🔊 Playing Human Lecture Audio...'
                  : playCount === 0
                  ? '▶ Play Human Audio (1st Listen: Just Listen)'
                  : '▶ Play Human Audio Again (2nd Listen: Fragment Notes)'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Shorthand Fragment Notes (Abbreviations, arrows, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: grammar accuracy <- multi-word chunks != isolated words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Do not write full sentences here — just key concepts</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                  window.speechSynthesis.cancel();
                }
                setIsPlaying(false);
                setPhase('reconstruct');
              }}
              className="px-5 py-2.5 bg-primary-600 text-white text-xs font-bold rounded-xl hover:bg-primary-700 cursor-pointer shadow-xs"
            >
              Lock Audio & Start Reconstruction →
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-amber-900">Your Shorthand Fragment Notes:</p>
              <p className="text-sm font-mono text-amber-800 mt-0.5">
                {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
              </p>
            </div>
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-bold text-primary-700 hover:underline">
                Peek at Verbatim Human Transcript (After Attempting)
              </summary>
              <p className="mt-2 p-3 bg-white rounded-lg border border-slate-200 max-w-xl text-slate-800">
                {sourcePassage}
              </p>
            </details>
          </div>

          <textarea
            value={reconstructedText}
            onKeyDown={handleReconstructionKeyDown}
            onChange={(e) => {
              const val = e.target.value;
              const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
              updateResponse(block.id, {
                textOrTranscript: val,
                promptSnapshot: sourcePassage,
                questionId: currentItem?.id,
              });
              if (wc >= 20 && currentItem && !completedIds.has(currentItem.id)) {
                void markQuestionCompleted(currentItem.id);
                setCompletedIds((prev) => new Set(prev).add(currentItem.id));
              }
            }}
            placeholder="Reconstruct the passage's full meaning in your own words using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[220px] p-4 text-base text-slate-800 bg-white border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>You are graded on meaning retention + C1/C2 grammar, not exact word matching</span>
            <span className="font-mono font-semibold text-slate-700">
              {reconWordCount} {reconWordCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 4. SESSION RUNNER: Spoken Collocation Evaluation & Clean Transition Props
  // =========================================================================
  'src/components/exam/SessionRunner.tsx': `import { useEffect, useRef, useCallback, useState } from 'react';
import {
  useSessionStore,
  selectCurrentBlock,
  selectBlockTimeRemaining,
  selectBlockProgress,
  selectIsLastBlock,
} from '../../stores/sessionStore';
import { TimerEngine } from '../../utils/timer';
import { formatTime } from '../../utils/helpers';
import { db, DEFAULT_SPEAKING_PROMPT } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { BlockInputRouter } from './BlockInputRouter';
import { TransitionOverlay } from './TransitionOverlay';

export function SessionRunner() {
  const isRunning = useSessionStore((s) => s.isRunning);
  const isPaused = useSessionStore((s) => s.isPaused);
  const transitionCountdown = useSessionStore((s) => s.transitionCountdown);
  const overallElapsedSec = useSessionStore((s) => s.overallElapsedSec);
  const currentBlockIndex = useSessionStore((s) => s.currentBlockIndex);
  const activeRun = useSessionStore((s) => s.activeRun);
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const lastSavedAt = useSessionStore((s) => s.lastSavedAt);
  const tick = useSessionStore((s) => s.tick);
  const pauseSession = useSessionStore((s) => s.pauseSession);
  const resumeRunning = useSessionStore((s) => s.resumeRunning);
  const advanceBlock = useSessionStore((s) => s.advanceBlock);
  const jumpToBlock = useSessionStore((s) => s.jumpToBlock);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const resetBlockForRewrite = useSessionStore((s) => s.resetBlockForRewrite);
  const abandonSession = useSessionStore((s) => s.abandonSession);

  const currentBlock = useSessionStore(selectCurrentBlock);
  const blockTimeRemaining = useSessionStore(selectBlockTimeRemaining);
  const blockProgress = useSessionStore(selectBlockProgress);
  const isLastBlock = useSessionStore(selectIsLastBlock);

  const [instantEvalLoading, setInstantEvalLoading] = useState(false);
  const [instantEvalError, setInstantEvalError] = useState<string | null>(null);

  const timerRef = useRef<TimerEngine | null>(null);

  useEffect(() => {
    timerRef.current = new TimerEngine(tick, 1000);
    timerRef.current.start();
    return () => timerRef.current?.stop();
  }, [tick]);

  useEffect(() => {
    if (!timerRef.current) return;
    if (isPaused) {
      timerRef.current.stop();
    } else if (isRunning) {
      timerRef.current.start();
    }
  }, [isPaused, isRunning]);

  const handleDone = useCallback(() => {
    setInstantEvalError(null);
    advanceBlock();
  }, [advanceBlock]);

  const handleInstantCheck = useCallback(async () => {
    if (!currentBlock) return;
    const resp = draftResponses[currentBlock.id];
    const studentText = (resp?.timestampedTranscript || resp?.textOrTranscript || '').trim();

    if (!studentText) {
      setInstantEvalError(
        'Write a response or record & transcribe your speech before requesting AI feedback.'
      );
      return;
    }

    pauseSession();
    setInstantEvalLoading(true);
    setInstantEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      const evalPrompts = await db.evalPrompts.toArray();

      // Detect if this block was answered via Spoken Voice Mode (including Spoken Collocation Drill!)
      const isSpokenResponse =
        currentBlock.type === 'speaking' ||
        currentBlock.type === 'shadowing' ||
        resp?.questionType === 'spoken-collocation-drill' ||
        Boolean(resp?.audioBlobRef);

      const evalPrompt = isSpokenResponse
        ? evalPrompts.find((ep) => ep.appliesToType === 'speaking')
        : evalPrompts.find((ep) => ep.id === currentBlock.evalPromptId) ??
          evalPrompts.find((ep) => ep.appliesToType === currentBlock.type) ??
          evalPrompts[0];

      const verifiedDuration =
        resp?.audioDurationSec || resp?.timeSpentSec || 60;

      const feedback = await evaluateResponse({
        apiKey: settings?.geminiApiKey ?? '',
        evalPromptTemplate:
          evalPrompt?.promptText ??
          (isSpokenResponse ? DEFAULT_SPEAKING_PROMPT : ''),
        variables: {
          prompt: resp?.promptSnapshot || currentBlock.instructions,
          response: studentText,
          transcript: studentText,
          durationSec: String(verifiedDuration),
          wpm: String(resp?.wpm ?? 0),
          fillerCount: String(resp?.fillerCount ?? 0),
        },
      });

      updateResponse(currentBlock.id, {
        aiFeedback: feedback,
        aiOverallScore: feedback.overallScore,
        aiSubscores: feedback.subscores,
      });
    } catch (err) {
      setInstantEvalError(
        err instanceof Error ? err.message : 'Instant evaluation failed.'
      );
    } finally {
      setInstantEvalLoading(false);
    }
  }, [currentBlock, draftResponses, pauseSession, updateResponse]);

  const handleAbandon = useCallback(async () => {
    if (
      window.confirm(
        'Exit this practice session? Your draft responses remain saved in History.'
      )
    ) {
      await abandonSession();
    }
  }, [abandonSession]);

  if (!activeRun || !currentBlock) return null;

  const currentResponse = draftResponses[currentBlock.id];
  const blockFeedback = currentResponse?.aiFeedback;
  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0;
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0;
  const totalBlocks = activeRun.blockConfigs.length;
  const nextBlock = activeRun.blockConfigs[currentBlockIndex + 1];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={nextBlock?.name ?? 'Next Block'}
        />
      )}

      {/* Sticky Top Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
        <div className="flex gap-1 px-2 pt-1.5">
          {activeRun.blockConfigs.map((block, i) => {
            let fill = 0;
            if (i < currentBlockIndex) fill = 1;
            else if (i === currentBlockIndex) fill = blockProgress;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => jumpToBlock(i)}
                title={\`Jump to Block \${i + 1}: \${block.name}\`}
                className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden cursor-pointer hover:opacity-80"
              >
                <div
                  className="h-full bg-primary-500 transition-all duration-500"
                  style={{ width: \`\${fill * 100}%\` }}
                />
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-md">
              Block {currentBlockIndex + 1} / {totalBlocks}
            </span>
            <span className="text-sm font-semibold text-slate-800">
              {currentBlock.name}
            </span>
            {currentResponse?.attemptCount && currentResponse.attemptCount > 1 && (
              <span className="text-xs font-bold bg-accent-100 text-accent-800 px-2 py-0.5 rounded-full">
                Attempt #{currentResponse.attemptCount}
              </span>
            )}
            {lastSavedAt && (
              <span className="text-[11px] text-slate-400 hidden sm:inline">
                Auto-saved
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 hidden md:inline">
              Total: {formatTime(overallElapsedSec)}
            </span>

            <div
              className={\`px-3 py-1 rounded-lg font-mono text-base font-bold \${
                isCritical
                  ? 'bg-red-600 text-white animate-pulse'
                  : isLowTime
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-800'
              }\`}
            >
              {formatTime(blockTimeRemaining)}
            </div>

            <button
              type="button"
              onClick={isPaused ? resumeRunning : pauseSession}
              className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>

            <button
              type="button"
              onClick={handleAbandon}
              className="px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
            >
              Exit
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-6 space-y-6">
        <BlockInputRouter block={currentBlock} />

        {instantEvalError && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-700">
            {instantEvalError}
          </div>
        )}

        {/* Instant AI Feedback Drawer */}
        {blockFeedback && (
          <div className="bg-white border-2 border-primary-300 rounded-2xl p-5 space-y-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
                  ⚡ Instant Deliberate-Practice Critique
                </span>
                <h4 className="text-base font-bold text-slate-900 mt-0.5">
                  Estimated DET Band: {blockFeedback.overallScore ?? '—'} / 160
                </h4>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => resetBlockForRewrite(currentBlock.id)}
                  className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl cursor-pointer shadow-2xs"
                >
                  ↺ Apply Fixes & Rewrite / Re-record Now
                </button>
                <button
                  type="button"
                  onClick={handleDone}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl cursor-pointer"
                >
                  {isLastBlock ? 'Finish Session →' : 'Continue to Next Block →'}
                </button>
              </div>
            </div>

            {blockFeedback.note && (
              <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                ℹ️ {blockFeedback.note}
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {blockFeedback.strengths.length > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                  <strong className="text-green-900 block mb-1">✓ Strengths</strong>
                  <ul className="list-disc list-inside space-y-1 text-green-800">
                    {blockFeedback.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blockFeedback.weaknesses.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <strong className="text-red-900 block mb-1">⚠️ Gaps to Fix</strong>
                  <ul className="list-disc list-inside space-y-1 text-red-800">
                    {blockFeedback.weaknesses.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {blockFeedback.suggestedFix && (
              <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs text-slate-900">
                <strong className="text-primary-800 block mb-1">
                  ✨ 150-Band C1/C2 Target Rewrite:
                </strong>
                <p className="italic leading-relaxed">{blockFeedback.suggestedFix}</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom Action Footer */}
      <footer className="sticky bottom-0 z-30 bg-white border-t border-slate-200 px-6 py-3.5">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {activeRun.instantFeedback && currentBlock.type !== 'interactive-reading' && (
              <button
                type="button"
                disabled={instantEvalLoading}
                onClick={() => void handleInstantCheck()}
                className="px-4 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                {instantEvalLoading
                  ? '⏳ Grading Response...'
                  : '⚡ Get Instant AI Critique & Score'}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleDone}
            className="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-bold rounded-xl cursor-pointer shadow-xs"
          >
            {isLastBlock
              ? '✓ Complete Session & View Final Score'
              : \`Next Block (\${currentBlockIndex + 2}/\${totalBlocks}) →\`}
          </button>
        </div>
      </footer>
    </div>
  );
}
`,

  // =========================================================================
  // 5. POST SESSION: Recognize Spoken Collocation Drills as Speech Evaluation
  // =========================================================================
  'src/components/exam/PostSession.tsx': `import { useEffect, useState, useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { db, DEFAULT_SPEAKING_PROMPT } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { formatTime } from '../../utils/helpers';
import type { AIFeedback, DETSkill } from '../../types';

export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun);
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun);
  const setView = useAppStore((s) => s.setView);

  const [evaluating, setEvaluating] = useState(false);
  const [evalProgress, setEvalProgress] = useState<string>('');
  const [evalError, setEvalError] = useState<string | null>(null);

  const evaluateAllBlocks = useCallback(async () => {
    if (!activeRun) return;
    setEvaluating(true);
    setEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      const evalPrompts = await db.evalPrompts.toArray();
      const apiKey = settings?.geminiApiKey ?? '';

      for (let i = 0; i < activeRun.blockConfigs.length; i++) {
        const block = activeRun.blockConfigs[i];
        const resp = draftResponses[block.id] ?? activeRun.responses[block.id];

        if (resp?.aiOverallScore !== undefined && resp?.aiFeedback) {
          continue;
        }

        const studentText = (resp?.timestampedTranscript || resp?.textOrTranscript || '').trim();

        if (!studentText) {
          const skippedFeedback: AIFeedback = {
            overallScore: 0,
            subscores: { literacy: 0, comprehension: 0, conversation: 0, production: 0 },
            criteria: {
              status: 'Block was skipped or left unanswered (counted as 0/160 toward session total).',
            },
            strengths: [],
            weaknesses: ['Block was skipped or left blank during the session.'],
            suggestions: ['Complete all blocks in the session to maximize your overall DET score.'],
          };
          updateResponse(block.id, {
            aiOverallScore: 0,
            aiSubscores: skippedFeedback.subscores,
            aiFeedback: skippedFeedback,
          });
          continue;
        }

        setEvalProgress(\`Evaluating Block \${i + 1} of \${activeRun.blockConfigs.length}: \${block.name}...\`);

        const isSpokenResponse =
          block.type === 'speaking' ||
          block.type === 'shadowing' ||
          resp?.questionType === 'spoken-collocation-drill' ||
          Boolean(resp?.audioBlobRef);

        const evalPrompt = isSpokenResponse
          ? evalPrompts.find((ep) => ep.appliesToType === 'speaking')
          : evalPrompts.find((ep) => ep.id === block.evalPromptId) ??
            evalPrompts.find((ep) => ep.appliesToType === block.type) ??
            evalPrompts[0];

        const verifiedDuration = resp?.audioDurationSec || resp?.timeSpentSec || 60;

        const feedback = await evaluateResponse({
          apiKey,
          evalPromptTemplate:
            evalPrompt?.promptText ??
            (isSpokenResponse ? DEFAULT_SPEAKING_PROMPT : ''),
          variables: {
            prompt: resp?.promptSnapshot || block.instructions,
            response: studentText,
            transcript: studentText,
            durationSec: String(verifiedDuration),
            wpm: String(resp?.wpm ?? 0),
            fillerCount: String(resp?.fillerCount ?? 0),
          },
        });

        updateResponse(block.id, {
          aiFeedback: feedback,
          aiOverallScore: feedback.overallScore ?? 0,
          aiSubscores: feedback.subscores,
        });
      }

      const latestResponses = useSessionStore.getState().draftResponses;
      const totalBlocksCount = Math.max(1, activeRun.blockConfigs.length);
      let totalScoreSum = 0;

      for (const b of activeRun.blockConfigs) {
        const r = latestResponses[b.id];
        totalScoreSum += r?.aiOverallScore ?? 0;
      }

      const penalizedOverallScore = Math.round(totalScoreSum / totalBlocksCount);
      await db.sessionRuns.update(activeRun.id, {
        responses: latestResponses,
        summary: {
          overallScore: penalizedOverallScore,
          durationSec: activeRun.overallElapsedSec,
        },
      });
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation encountered an error.');
    } finally {
      setEvaluating(false);
      setEvalProgress('');
    }
  }, [activeRun, draftResponses, updateResponse]);

  useEffect(() => {
    void evaluateAllBlocks();
  }, [evaluateAllBlocks]);

  if (!activeRun) return null;

  const blocks = activeRun.blockConfigs;
  const totalBlocks = Math.max(1, blocks.length);

  let sumAllBlocks = 0;
  let answeredBlocksCount = 0;
  let sumAnsweredOnly = 0;

  const subscoreTotals: Record<string, { sum: number; count: number }> = {
    literacy: { sum: 0, count: 0 },
    comprehension: { sum: 0, count: 0 },
    conversation: { sum: 0, count: 0 },
    production: { sum: 0, count: 0 },
  };

  for (const b of blocks) {
    const r = draftResponses[b.id] ?? activeRun.responses[b.id];
    const hasContent = Boolean(
      r?.textOrTranscript?.trim() || r?.audioBlobRef || (r?.aiOverallScore && r.aiOverallScore > 0)
    );
    const blockScore = hasContent ? (r?.aiOverallScore ?? 0) : 0;

    sumAllBlocks += blockScore;
    if (hasContent && blockScore > 0) {
      answeredBlocksCount += 1;
      sumAnsweredOnly += blockScore;
    }

    for (const key of ['literacy', 'comprehension', 'conversation', 'production'] as DETSkill[] | string[]) {
      const subVal = hasContent ? (r?.aiSubscores?.[key] ?? blockScore) : 0;
      if (subscoreTotals[key]) {
        subscoreTotals[key].sum += subVal;
        subscoreTotals[key].count += 1;
      }
    }
  }

  const strictOverallScore = Math.round(sumAllBlocks / totalBlocks);
  const answeredOnlyAverage =
    answeredBlocksCount > 0 ? Math.round(sumAnsweredOnly / answeredBlocksCount) : 0;
  const skippedCount = totalBlocks - answeredBlocksCount;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-md space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-primary-400">
              Session Complete • {activeRun.templateName}
            </span>
            <h2 className="text-2xl font-bold mt-1">
              Official-Style DET Performance Breakdown
            </h2>
            <p className="text-xs text-slate-300 mt-0.5">
              Total Time: {formatTime(activeRun.overallElapsedSec)} • Blocks Completed:{' '}
              {answeredBlocksCount} of {totalBlocks}
              {skippedCount > 0
                ? \` (\${skippedCount} skipped block\${skippedCount > 1 ? 's' : ''} counted as 0)\`
                : ' (All blocks completed ✓)'}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right bg-slate-800 border border-slate-700 px-4 py-2.5 rounded-xl">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                True Session Score (All {totalBlocks} Blocks)
              </p>
              <p className="text-3xl font-extrabold text-primary-400 font-mono">
                {strictOverallScore} <span className="text-sm text-slate-400">/ 160</span>
              </p>
              {skippedCount > 0 && answeredOnlyAverage > 0 && (
                <p className="text-[11px] text-amber-300 mt-0.5">
                  Answered-Only Avg: {answeredOnlyAverage}/160 (-{answeredOnlyAverage - strictOverallScore} penalty for {skippedCount} skipped)
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          {(['literacy', 'comprehension', 'conversation', 'production'] as const).map((sub) => {
            const stat = subscoreTotals[sub];
            const val = stat.count > 0 ? Math.round(stat.sum / stat.count) : 0;
            return (
              <div
                key={sub}
                className="bg-slate-800/90 border border-slate-700 rounded-xl p-3"
              >
                <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">
                  {sub}
                </p>
                <p className="text-xl font-bold text-white font-mono mt-0.5">
                  {val} <span className="text-xs text-slate-400">/ 160</span>
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {evaluating && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-5 flex items-center justify-center gap-3 text-sm font-semibold text-accent-900">
          <div className="w-5 h-5 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <span>{evalProgress || 'Evaluating session blocks...'}</span>
        </div>
      )}

      {evalError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-700 flex items-center justify-between">
          <span>{evalError}</span>
          <button
            type="button"
            onClick={() => void evaluateAllBlocks()}
            className="px-3 py-1 bg-red-600 text-white font-bold rounded-lg cursor-pointer"
          >
            Retry Evaluation
          </button>
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          Block-by-Block Evaluation ({blocks.length} Blocks)
        </h3>

        {blocks.map((block, idx) => {
          const resp = draftResponses[block.id] ?? activeRun.responses[block.id];
          const fb = resp?.aiFeedback;
          const hasContent = Boolean(
            resp?.textOrTranscript?.trim() ||
              resp?.audioBlobRef ||
              (resp?.aiOverallScore && resp.aiOverallScore > 0)
          );
          const score = hasContent ? (resp?.aiOverallScore ?? 0) : 0;

          return (
            <div
              key={block.id}
              className={\`bg-white rounded-2xl border-2 p-5 space-y-4 shadow-2xs \${
                !hasContent ? 'border-amber-200 bg-amber-50/20' : 'border-slate-200'
              }\`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <div>
                    <h4 className="font-bold text-slate-900 text-sm">{block.name}</h4>
                    <span className="text-xs text-slate-500">
                      Mode: {resp?.questionType || block.type} • Time Spent:{' '}
                      {formatTime(resp?.timeSpentSec ?? 0)}
                    </span>
                  </div>
                </div>

                <span
                  className={\`px-3 py-1 rounded-full text-xs font-extrabold font-mono \${
                    !hasContent || score === 0
                      ? 'bg-red-100 text-red-800 border border-red-300'
                      : score >= 135
                      ? 'bg-green-100 text-green-800 border border-green-300'
                      : 'bg-primary-100 text-primary-800 border border-primary-300'
                  }\`}
                >
                  {!hasContent ? '0 / 160 (Skipped)' : \`\${score} / 160\`}
                </span>
              </div>

              {resp?.promptSnapshot && (
                <div className="text-xs bg-slate-50 p-3 rounded-lg border border-slate-200 text-slate-700 whitespace-pre-wrap">
                  <strong className="text-slate-900">Task Prompt:</strong> {resp.promptSnapshot}
                </div>
              )}

              {resp?.audioBlobRef && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-1">Your Recorded Audio:</p>
                  <audio controls src={resp.audioBlobRef} className="w-full h-9" />
                </div>
              )}

              {resp?.textOrTranscript && (
                <div className="text-xs bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-slate-800 whitespace-pre-wrap leading-relaxed">
                  <strong className="block text-slate-600 mb-1">
                    Submitted Response / Transcript:
                  </strong>
                  {resp.textOrTranscript}
                </div>
              )}

              {fb && (
                <div className="space-y-3 pt-1">
                  {fb.note && (
                    <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">
                      ℹ️ {fb.note}
                    </p>
                  )}

                  {Object.keys(fb.criteria ?? {}).length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                      {Object.entries(fb.criteria).map(([k, v]) => (
                        <div
                          key={k}
                          className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 text-xs"
                        >
                          <strong className="uppercase text-[10px] text-slate-500 block">
                            {k.replace(/_/g, ' ')}
                          </strong>
                          <span className="text-slate-800">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    {fb.strengths.length > 0 && (
                      <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                        <strong className="text-green-900 block mb-1">✓ Strengths</strong>
                        <ul className="list-disc list-inside space-y-1 text-green-800">
                          {fb.strengths.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {fb.weaknesses.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                        <strong className="text-red-900 block mb-1">⚠️ Areas to Fix</strong>
                        <ul className="list-disc list-inside space-y-1 text-red-800">
                          {fb.weaknesses.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {fb.suggestedFix && (
                    <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs text-slate-900">
                      <strong className="text-primary-800 block mb-1">
                        ✨ 150-Band C1/C2 Model Rewrite:
                      </strong>
                      <p className="italic leading-relaxed">{fb.suggestedFix}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200">
        <button
          type="button"
          onClick={() => {
            clearActiveRun();
            setView('config');
          }}
          className="px-5 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold rounded-xl cursor-pointer"
        >
          ← Return to 21-Day Dashboard
        </button>

        <button
          type="button"
          onClick={() => {
            clearActiveRun();
            setView('exam');
          }}
          className="px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white text-sm font-bold rounded-xl cursor-pointer shadow-xs"
        >
          🎯 Back to Daily Sessions Hub →
        </button>
      </div>
    </div>
  );
}
`,
};

const cwd = process.cwd();
for (const [relPath, content] of Object.entries(files)) {
  const targetPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('Updated:', path.relative(cwd, targetPath));
}
console.log('\nBuild fix, Real Human Audio Dictogloss, and Spoken Collocation Mode applied!');