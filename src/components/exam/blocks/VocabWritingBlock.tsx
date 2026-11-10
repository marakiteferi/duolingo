import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
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

  if (chunks.length === 0) return `${modeHeader}\n${basePrompt}`;
  return `${modeHeader}\nTask: ${basePrompt}\nRequired 4 Collocation Chunks: ${chunks
    .map((c) => `"${c}"`)
    .join(', ')}`;
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
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

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
        `Could not start recording: ${e instanceof Error ? e.message : 'Unknown error'}`
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
      const wc = val.trim() ? val.trim().split(/\s+/).length : 0;
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
      `✓ Marked Done & SRS Updated (${label}): Next review in ${updatedSrs.intervalDays}d`
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
              className={`px-3 py-1.5 text-xs font-bold rounded-md cursor-pointer transition-all ${
                inputMode === 'written'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ✍️ Written Collocation Drill
            </button>
            <button
              type="button"
              onClick={() => handleSwitchInputMode('spoken')}
              className={`px-3 py-1.5 text-xs font-bold rounded-md cursor-pointer transition-all ${
                inputMode === 'spoken'
                  ? 'bg-red-600 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
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
                    {q.dayNumber ? `Day ${q.dayNumber}: ` : `Set #${idx + 1}: `}
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
                className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                  usedChunksCount === activeChunks.length
                    ? 'bg-green-600 text-white'
                    : 'bg-white text-accent-800 border border-accent-300'
                }`}
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
                    key={`${activeQuestion?.id}-chunk-${idx}`}
                    className={`flex items-center justify-between px-3.5 py-2 rounded-xl border-2 text-xs font-mono font-bold transition-all ${
                      isUsed
                        ? 'bg-green-100 border-green-500 text-green-900 shadow-2xs'
                        : 'bg-white border-accent-300 text-slate-800'
                    }`}
                  >
                    <span>
                      {idx + 1}. "{chunk}"
                    </span>
                    <span
                      className={`text-[11px] font-sans font-bold px-2 py-0.5 rounded ${
                        isUsed
                          ? 'bg-green-600 text-white'
                          : 'bg-slate-100 text-slate-500'
                      }`}
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
                    style={{ height: `${Math.max(6, level)}%` }}
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
