// upgrade-phase2.mjs
// Run from project root: node upgrade-phase2.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. SHADOWING BLOCK: Arguelles Motor-Auditory Simultaneous Shadowing
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
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

function computeWordMatchPercent(source: string, spoken: string): number {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, '')
      .split(/\\s+/)
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
  const [speechRate, setSpeechRate] = useState<number>(1.0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  useEffect(() => {
    db.questionBank.toArray().then((all) => {
      const shadowItems = all.filter(
        (q) => q.tags.includes('shadowing') || q.type === 'read-aloud' || q.sourceAudioText
      );
      setPassages(shadowItems.length > 0 ? shadowItems : all);
    });
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, []);

  const sourceText =
    passages[selectedIdx]?.sourceAudioText ||
    passages[selectedIdx]?.prompt ||
    'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.';

  const playNativeAudio = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setError('Browser SpeechSynthesis is not supported in this environment.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourceText);
    utterance.lang = 'en-US';
    utterance.rate = speechRate;
    utterance.onstart = () => setIsPlayingAudio(true);
    utterance.onend = () => setIsPlayingAudio(false);
    utterance.onerror = () => setIsPlayingAudio(false);
    window.speechSynthesis.speak(utterance);
  }, [sourceText, speechRate]);

  const stopNativeAudio = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsPlayingAudio(false);
    }
  }, []);

  const handleStartShadowing = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied.');
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
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shadowing transcription failed');
      setRecordingState('idle');
    }
  }, [block.id, sourceText, stopNativeAudio, updateResponse]);

  const matchPercent = computeWordMatchPercent(sourceText, response?.textOrTranscript ?? '');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WhisperLiveIndicator />
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">Native Speed:</label>
          {[0.9, 1.0, 1.1].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => setSpeechRate(rate)}
              className={\`px-2.5 py-1 text-xs rounded-lg font-mono font-semibold border \${
                speechRate === rate
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-700 border-slate-200'
              }\`}
            >
              {rate}x
            </button>
          ))}
          {passages.length > 1 && (
            <button
              type="button"
              onClick={() => setSelectedIdx((i) => (i + 1) % passages.length)}
              className="text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1 rounded-lg"
            >
              Switch Passage ({selectedIdx + 1}/{passages.length})
            </button>
          )}
        </div>
      </div>

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
            Arguelles Shadowing Passage (Lag by ~0.5s, mirror rhythm & stress)
          </span>
          <button
            type="button"
            onClick={isPlayingAudio ? stopNativeAudio : playNativeAudio}
            className="text-xs font-semibold px-3 py-1 rounded-lg bg-white border border-primary-300 text-primary-800 hover:bg-primary-100"
          >
            {isPlayingAudio ? 'Stop Audio Preview' : 'Listen First (Preview)'}
          </button>
        </div>
        <p className="text-base text-slate-900 leading-relaxed font-medium">{sourceText}</p>
      </div>

      <div className="flex justify-center">
        {recordingState !== 'recording' && recordingState !== 'transcribing' && (
          <button
            type="button"
            onClick={handleStartShadowing}
            className="px-7 py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-lg cursor-pointer flex items-center gap-3"
          >
            <span className="w-3 h-3 rounded-full bg-white animate-ping" />
            Play Native Audio & Record Shadowing Simultaneously
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
              <p className="text-xs text-slate-500">Audio Duration</p>
              <p className="text-lg font-bold text-slate-800">{response.audioDurationSec ?? recordingSeconds}s</p>
            </div>
          </div>

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
`,

  // =========================================================================
  // 2. DICTOGLOSS BLOCK: Working Memory + Fragment Notes -> Reconstruction
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [phase, setPhase] = useState<'listen' | 'reconstruct'>('listen');
  const [playCount, setPlayCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const response = draftResponses[block.id];
  const fragmentNotes = response?.fragmentNotes ?? '';
  const reconstructedText = response?.textOrTranscript ?? '';

  useEffect(() => {
    db.questionBank.toArray().then((all) => {
      const items = all.filter((q) => q.tags.includes('dictogloss') || q.skill === 'listening');
      setPassages(items.length > 0 ? items : all);
    });
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const sourcePassage =
    passages[0]?.sourceAudioText ||
    passages[0]?.prompt ||
    'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.';

  const handlePlayPassage = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourcePassage);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => {
      setIsPlaying(false);
      setPlayCount((c) => c + 1);
    };
    window.speechSynthesis.speak(utterance);
  }, [sourcePassage]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // Limit fragment notes to ~25 words so user compresses into symbols/keywords
    const words = val.trim().split(/\\s+/).filter(Boolean);
    if (words.length > 25) return;
    updateResponse(block.id, {
      fragmentNotes: val,
      promptSnapshot: sourcePassage,
    });
  };

  const handleReconstructionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\\s+/).length : 0;

  return (
    <div className="space-y-5">
      {/* Phase Toggle Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-accent-700">
            Dictogloss Working-Memory Protocol
          </span>
          <p className="text-xs text-slate-500 mt-0.5">
            Phase 1: Listen & take compressed 2-4 word fragment notes. Phase 2: Reconstruct full meaning from memory.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPhase('listen')}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg \${
              phase === 'listen' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            1. Listen & Fragment Notes
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              setIsPlaying(false);
              setPhase('reconstruct');
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg \${
              phase === 'reconstruct' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
          >
            2. Reconstruct Meaning
          </button>
        </div>
      </div>

      {phase === 'listen' ? (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-accent-800">
              Audio Listens Used: {playCount} / 2 (Passage text is hidden to train working memory)
            </span>
            <button
              type="button"
              onClick={handlePlayPassage}
              disabled={isPlaying}
              className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer"
            >
              {isPlaying ? 'Playing Lecture Audio...' : playCount === 0 ? 'Play Passage (1st Listen)' : 'Play Again (Note-Taking Listen)'}
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Fragment Notes Only (Abbreviations, symbols, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: interm -> adv req multi-word chunks / time press != isol words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Compress clauses into 2–4 word fragments</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setPhase('reconstruct')}
              className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Lock Audio & Start Reconstruction ->
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5">
            <p className="text-xs font-bold text-amber-900">Your Compressed Fragment Notes:</p>
            <p className="text-sm font-mono text-amber-800 mt-1">
              {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
            </p>
          </div>

          <textarea
            value={reconstructedText}
            onKeyDown={handleReconstructionKeyDown}
            onChange={(e) =>
              updateResponse(block.id, {
                textOrTranscript: e.target.value,
                promptSnapshot: sourcePassage,
              })
            }
            placeholder="Reconstruct the passage's full meaning using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[240px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 3. VOCAB WRITING BLOCK: Live Collocation Chunk Tracker + Pressure Mode
  // =========================================================================
  'src/components/exam/blocks/VocabWritingBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import { initSRS, reviewItem, getDueItems } from '../../../utils/srs';
import type { BlockConfig, QuestionBankItem } from '../../../types';

export function VocabWritingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [dueQuestions, setDueQuestions] = useState<QuestionBankItem[]>([]);
  const [activeQuestion, setActiveQuestion] = useState<QuestionBankItem | null>(null);
  const [gradedMessage, setGradedMessage] = useState<string | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  useEffect(() => {
    const loadVocabItems = async () => {
      const all = await db.questionBank.toArray();
      const chunkItems = all.filter(
        (q) => (q.targetChunks && q.targetChunks.length > 0) || q.skill === 'writing' || q.tags.includes('vocab')
      );
      const due = getDueItems(chunkItems.length > 0 ? chunkItems : all);
      const list = due.length > 0 ? due : chunkItems;
      setDueQuestions(list);
      if (list.length > 0) {
        setActiveQuestion(list[0]);
      }
    };
    void loadVocabItems();
  }, []);

  const targetChunks = activeQuestion?.targetChunks ?? [
    'rigorous empirical validation',
    'shift the research paradigm',
    'ubiquitous adoption of',
    'bear the consequences',
  ];

  const promptText =
    activeQuestion?.prompt ||
    block.instructions ||
    'Write a dense academic paragraph incorporating all target multi-word collocation chunks below.';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, {
        textOrTranscript: e.target.value,
        promptSnapshot: \`\${promptText} (Required Chunks: \${targetChunks.join('; ')})\`,
        questionId: activeQuestion?.id,
      });
    },
    [activeQuestion?.id, block.id, promptText, targetChunks, updateResponse]
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
    const updatedItem: QuestionBankItem = { ...activeQuestion, srs: updatedSrs };
    await db.questionBank.put(updatedItem);
    setActiveQuestion(updatedItem);
    setGradedMessage(\`SRS Updated (\${label}): Next review in \${updatedSrs.intervalDays} day(s)\`);
    setTimeout(() => setGradedMessage(null), 3500);
  };

  const lowerText = text.toLowerCase();

  return (
    <div className="space-y-4">
      {dueQuestions.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
              {dueQuestions.length} SRS Chunk Set{dueQuestions.length === 1 ? '' : 's'}
            </span>
            <select
              value={activeQuestion?.id ?? ''}
              onChange={(e) => {
                const found = dueQuestions.find((q) => q.id === e.target.value) ?? null;
                setActiveQuestion(found);
              }}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700"
            >
              {dueQuestions.map((q, idx) => (
                <option key={q.id} value={q.id}>
                  #{idx + 1} {q.prompt.slice(0, 58)}...
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 mr-1">Rate Chunk Recall:</span>
            <button
              type="button"
              onClick={() => handleRateSRS(2, 'Hard / Reset')}
              className="px-2.5 py-1 text-xs font-medium bg-red-50 text-red-700 rounded hover:bg-red-100"
            >
              Again (1d)
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(4, 'Good')}
              className="px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
            >
              Good
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(5, 'Easy')}
              className="px-2.5 py-1 text-xs font-medium bg-green-50 text-green-700 rounded hover:bg-green-100"
            >
              Easy
            </button>
          </div>
        </div>
      )}

      {gradedMessage && (
        <div className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {gradedMessage}
        </div>
      )}

      {/* Prompt & Multi-Word Collocation Chunks */}
      <div className="bg-accent-50 border border-accent-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-accent-700 uppercase tracking-wide">
            Chunk-Based Collocation Prompt (Avoid isolated word translation)
          </p>
          {communicativePressure && (
            <span className="text-[11px] font-bold bg-red-100 text-red-800 px-2 py-0.5 rounded">
              Hardcore Mode: Backspace Disabled
            </span>
          )}
        </div>
        <p className="text-sm text-slate-800 leading-relaxed font-medium">{promptText}</p>

        <div className="flex flex-wrap gap-2 pt-1">
          {targetChunks.map((chunk) => {
            const used = lowerText.includes(chunk.toLowerCase());
            return (
              <span
                key={chunk}
                className={\`text-xs font-semibold px-3 py-1 rounded-full border transition-all \${
                  used
                    ? 'bg-green-100 text-green-800 border-green-300'
                    : 'bg-white text-slate-700 border-accent-200'
                }\`}
              >
                {used ? '✓ ' : '+ '}
                "{chunk}"
              </span>
            );
          })}
        </div>

        {activeQuestion?.sampleAnswer && (
          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-accent-700">
              Show Reference 150-Band C1/C2 Sample Answer
            </summary>
            <p className="mt-1.5 p-2.5 bg-white/80 rounded-lg border border-accent-100 italic">
              {activeQuestion.sampleAnswer}
            </p>
          </details>
        )}
      </div>

      {response?.previousDraft && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
          <strong>Previous Attempt Draft (Notice the gap & upgrade):</strong>
          <p className="mt-1 italic text-slate-700">{response.previousDraft}</p>
        </div>
      )}

      <div>
        <textarea
          value={text}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          placeholder="Write your academic paragraph incorporating all multi-word chunks above..."
          className="w-full min-h-[280px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-accent-400 leading-relaxed"
          spellCheck
          autoFocus
        />
        <div className="flex justify-between mt-1.5 text-xs text-slate-500">
          <span>Target: 75–120 words with embedded subordination</span>
          <span className={wordCount >= 75 ? 'text-green-600 font-semibold' : ''}>
            {wordCount} words {wordCount >= 75 ? '✓' : '/ 75+'}
          </span>
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 4. SPEAKING BLOCK: Timestamped Transcript + True Duration + Hardcore Mode
  // =========================================================================
  'src/components/exam/blocks/SpeakingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
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
      setError(\`Recording failed: \${e instanceof Error ? e.message : 'Unknown error'}\`);
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
      setError(\`Could not start recording: \${e instanceof Error ? e.message : 'Unknown error'}\`);
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
                style={{ height: \`\${Math.max(6, level)}%\` }}
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
              style={{ width: \`\${transcribeProgress}%\` }}
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
                className={\`text-lg font-bold \${
                  speechStats.wpm >= 115 && speechStats.wpm <= 165 ? 'text-green-600' : 'text-amber-600'
                }\`}
              >
                {speechStats.wpm} WPM
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Verbatim Fillers</p>
              <p
                className={\`text-lg font-bold \${
                  speechStats.fillerCount <= 2 ? 'text-green-600' : 'text-red-600'
                }\`}
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
`,

  // =========================================================================
  // 5. BRAIN DUMP BLOCK: Enforce Communicative Pressure (No Backspace)
  // =========================================================================
  'src/components/exam/blocks/BrainDumpBlock.tsx': `import { useCallback } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import type { BlockConfig } from '../../../types';

export function BrainDumpBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, { textOrTranscript: e.target.value });
    },
    [block.id, updateResponse]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  return (
    <div className="flex flex-col h-full space-y-3">
      {communicativePressure && (
        <div className="text-xs font-bold bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded-lg">
          Strict Communicative Pressure Mode Active: Backspace and Delete are disabled. Keep producing forward!
        </div>
      )}
      <textarea
        value={text}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        placeholder="Start writing freely — don't stop, don't self-censor, just produce."
        className="flex-1 w-full min-h-[360px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed"
        spellCheck
        autoFocus
      />
      <div className="flex justify-end text-xs text-slate-400">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 6. BLOCK INPUT ROUTER: Route ShadowingBlock & DictoglossBlock
  // =========================================================================
  'src/components/exam/BlockInputRouter.tsx': `import type { BlockConfig } from '../../types';
import { BrainDumpBlock } from './blocks/BrainDumpBlock';
import { VocabWritingBlock } from './blocks/VocabWritingBlock';
import { SpeakingBlock } from './blocks/SpeakingBlock';
import { ShadowingBlock } from './blocks/ShadowingBlock';
import { DictoglossBlock } from './blocks/DictoglossBlock';
import { MockTestBlock } from './blocks/MockTestBlock';
import { CustomBlock } from './blocks/CustomBlock';

interface BlockInputRouterProps {
  block: BlockConfig;
}

export function BlockInputRouter({ block }: BlockInputRouterProps) {
  switch (block.type) {
    case 'brain-dump':
      return <BrainDumpBlock block={block} />;
    case 'vocab-writing':
      return <VocabWritingBlock block={block} />;
    case 'speaking':
      return <SpeakingBlock block={block} />;
    case 'shadowing':
      return <ShadowingBlock block={block} />;
    case 'dictogloss':
      return <DictoglossBlock block={block} />;
    case 'mock-test':
      return <MockTestBlock block={block} />;
    case 'custom':
      return <CustomBlock block={block} />;
    default:
      return (
        <div className="text-center py-8 text-slate-400">
          Unknown block type: {(block as BlockConfig).type}
        </div>
      );
  }
}
`,

  // =========================================================================
  // 7. PRE-SESSION: Recurring Error Log Priming + Communicative Pressure Toggle
  // =========================================================================
  'src/components/exam/PreSession.tsx': `import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import type { SessionRun, DETQuestionType } from '../../types';
import { formatTime } from '../../utils/helpers';
import { extractRecurringErrors, type RecurringErrorItem } from '../../utils/errorLog';
import { WhisperLiveIndicator } from '../common/WhisperLiveIndicator';

export function PreSession() {
  const setView = useAppStore((s) => s.setView);
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const startSession = useSessionStore((s) => s.startSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const selectedTemplateId = useSessionStore((s) => s.selectedTemplateId);
  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);

  const [incompleteRun, setIncompleteRun] = useState<SessionRun | null>(null);
  const [recurringErrors, setRecurringErrors] = useState<RecurringErrorItem[]>([]);
  const [micStatus, setMicStatus] = useState<'unchecked' | 'granted' | 'denied'>('unchecked');
  const [starting, setStarting] = useState(false);

  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [customDurations, setCustomDurations] = useState<Record<string, number>>({});
  const [instantFeedback, setInstantFeedback] = useState<boolean>(true);
  const [communicativePressure, setCommunicativePressure] = useState<boolean>(false);
  const [preferredQuestionType, setPreferredQuestionType] = useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  useEffect(() => {
    ensureDatabaseUpgraded().then(() => loadTemplates());
    db.sessionRuns
      .orderBy('startedAt')
      .reverse()
      .toArray()
      .then((allRuns) => {
        const inProg = allRuns.find((r) => r.status === 'in-progress');
        if (inProg) setIncompleteRun(inProg);
        setRecurringErrors(extractRecurringErrors(allRuns, 3));
      });
  }, [loadTemplates]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId, setSelectedTemplateId]);

  useEffect(() => {
    if (selectedTemplate) {
      setSelectedBlockIds(selectedTemplate.blocks.map((b) => b.id));
      const durations: Record<string, number> = {};
      for (const b of selectedTemplate.blocks) {
        durations[b.id] = b.durationSec;
      }
      setCustomDurations(durations);
    }
  }, [selectedTemplate]);

  const activeBlocks =
    selectedTemplate?.blocks.filter((b) => selectedBlockIds.includes(b.id)) ?? [];
  const hasSpeakingBlock = activeBlocks.some((b) => b.type === 'speaking' || b.type === 'shadowing');
  const totalSec = activeBlocks.reduce(
    (sum, b) => sum + (customDurations[b.id] ?? b.durationSec),
    0
  );

  const toggleBlockSelection = (blockId: string) => {
    setSelectedBlockIds((prev) =>
      prev.includes(blockId) ? prev.filter((id) => id !== blockId) : [...prev, blockId]
    );
  };

  const handleMicCheck = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  };

  const handleStart = async () => {
    if (!selectedTemplate || activeBlocks.length === 0) return;
    setStarting(true);
    await startSession(selectedTemplate, {
      selectedBlockIds,
      customDurations,
      instantFeedback,
      communicativePressure,
      preferredQuestionType,
    });
  };

  const handleDiscardIncomplete = async () => {
    if (!incompleteRun) return;
    await db.sessionRuns.update(incompleteRun.id, {
      status: 'abandoned',
      endedAt: new Date().toISOString(),
    });
    setIncompleteRun(null);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setView('config')}
          className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 px-3.5 py-2 rounded-lg cursor-pointer"
        >
          ← Back to Dashboard
        </button>
        <WhisperLiveIndicator />
      </div>

      {/* SLA Priming: Recurring Error Log */}
      {recurringErrors.length > 0 && (
        <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Pre-Session Cognitive Priming: Top Recurring Error Log
            </h3>
            <span className="text-[11px] font-semibold text-amber-700">
              Consciously monitor these during output
            </span>
          </div>
          <ul className="space-y-1.5">
            {recurringErrors.map((err, i) => (
              <li key={i} className="text-xs text-slate-800 flex items-start justify-between gap-2 bg-white/80 p-2 rounded-lg border border-amber-100">
                <span>
                  <strong className="uppercase text-[10px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 mr-2">
                    {err.category}
                  </strong>
                  {err.issue}
                </span>
                <span className="text-[11px] font-mono font-bold text-amber-800 shrink-0">
                  {err.count}x
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {incompleteRun && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-amber-900">Incomplete Session Found</h3>
            <p className="text-xs text-amber-700">
              Started {new Date(incompleteRun.startedAt).toLocaleString()} • Block{' '}
              {incompleteRun.currentBlockIndex + 1} of {incompleteRun.blockConfigs.length}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resumeSession(incompleteRun)}
              className="px-4 py-2 bg-amber-600 text-white text-xs font-semibold rounded-lg hover:bg-amber-700"
            >
              Resume Session
            </button>
            <button
              onClick={handleDiscardIncomplete}
              className="px-3 py-2 text-xs text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* 1. Template Picker */}
      <div className="mb-6">
        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          1. Select Practice Protocol / Template
        </label>
        <div className="grid gap-3">
          {templates.map((t) => (
            <label
              key={t.id}
              className={\`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all \${
                selectedTemplateId === t.id
                  ? 'border-primary-500 bg-primary-50/60'
                  : 'border-slate-200 bg-white hover:border-primary-300'
              }\`}
            >
              <input
                type="radio"
                name="template"
                checked={selectedTemplateId === t.id}
                onChange={() => setSelectedTemplateId(t.id)}
                className="mt-1 text-primary-600"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900">{t.name}</p>
                  <span className="text-xs font-mono text-slate-500">{t.blocks.length} blocks</span>
                </div>
                {t.description && <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>}
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* 2. Select Blocks */}
      {selectedTemplate && (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-slate-800">
              2. Select Blocks to Run ({activeBlocks.length} of {selectedTemplate.blocks.length})
            </h3>
            <span className="text-xs font-mono font-semibold text-slate-700">
              Total: {formatTime(totalSec)}
            </span>
          </div>
          <div className="space-y-2">
            {selectedTemplate.blocks.map((b, i) => {
              const checked = selectedBlockIds.includes(b.id);
              const durMin = Math.max(1, Math.round((customDurations[b.id] ?? b.durationSec) / 60));
              return (
                <div
                  key={b.id}
                  className={\`flex items-center justify-between p-3 rounded-lg border \${
                    checked ? 'bg-slate-50 border-slate-200' : 'opacity-50 border-slate-100'
                  }\`}
                >
                  <label className="flex items-center gap-3 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBlockSelection(b.id)}
                    />
                    <span className="text-sm font-semibold text-slate-800">
                      {i + 1}. {b.name}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-600">
                      {b.type}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={durMin}
                      onChange={(e) =>
                        setCustomDurations((prev) => ({
                          ...prev,
                          [b.id]: Math.max(1, Number(e.target.value)) * 60,
                        }))
                      }
                      className="w-16 px-2 py-1 text-xs font-mono border border-slate-300 rounded text-right"
                    />
                    <span className="text-xs text-slate-500">min</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. Feedback Mode & Communicative Pressure */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
            3. Deliberate Practice & Pressure Settings
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={instantFeedback}
              onChange={(e) => setInstantFeedback(e.target.checked)}
              className="mt-1"
            />
            <div>
              <p className="text-sm font-semibold text-slate-800">Instant Write-Critique-Rewrite Loop</p>
              <p className="text-xs text-slate-500">
                Grade immediately & unlock the "Apply Fixes & Rewrite/Re-record" button.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer pt-2 border-t border-slate-100">
            <input
              type="checkbox"
              checked={communicativePressure}
              onChange={(e) => setCommunicativePressure(e.target.checked)}
              className="mt-1 accent-red-600"
            />
            <div>
              <p className="text-sm font-bold text-red-700">Strict Communicative Pressure Mode</p>
              <p className="text-xs text-slate-500">
                Disables Backspace/Delete in writing and hides Stop in speaking until timer ends.
              </p>
            </div>
          </label>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            4. Question Selection Mode
          </label>
          <select
            value={preferredQuestionType}
            onChange={(e) =>
              setPreferredQuestionType(e.target.value as DETQuestionType | 'all' | 'adaptive')
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-800 mb-2"
          >
            <option value="adaptive">Adaptive + SRS Due First (Recommended)</option>
            <option value="all">All Question Types</option>
            <option value="interactive-writing">Interactive Writing Only</option>
            <option value="write-about-photo">Write About Photo Only</option>
            <option value="speaking-sample">Speaking Sample Only</option>
            <option value="interactive-speaking">Interactive Speaking Only</option>
            <option value="read-aloud">Read Aloud / Shadowing Only</option>
            <option value="listen-and-type">Listen & Type / Dictogloss Only</option>
          </select>
          {hasSpeakingBlock && (
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
              <span className="text-xs text-slate-600">Microphone Status:</span>
              {micStatus === 'granted' ? (
                <span className="text-xs font-semibold text-green-600">✓ Mic Ready</span>
              ) : (
                <button
                  type="button"
                  onClick={handleMicCheck}
                  className="text-xs font-semibold text-primary-600 hover:underline"
                >
                  Test Microphone
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={handleStart}
        disabled={!selectedTemplate || activeBlocks.length === 0 || starting}
        className="w-full py-4 bg-primary-600 text-white text-base font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 cursor-pointer shadow-sm"
      >
        {starting
          ? 'Starting Session...'
          : \`Start Practice (\${activeBlocks.length} Block\${activeBlocks.length === 1 ? '' : 's'} • \${formatTime(totalSec)})\`}
      </button>
    </div>
  );
}
`,

  // =========================================================================
  // 8. SESSION RUNNER: Write-Critique-Rewrite Loop + Timestamped Variables
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
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { BlockInputRouter } from './BlockInputRouter';
import { TransitionOverlay } from './TransitionOverlay';
import { WhisperLiveIndicator } from '../common/WhisperLiveIndicator';

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
    const studentText = resp?.textOrTranscript?.trim() ?? '';
    if (!studentText) {
      setInstantEvalError('Write a response or record & transcribe your speech before requesting AI feedback.');
      return;
    }

    pauseSession();
    setInstantEvalLoading(true);
    setInstantEvalError(null);

    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        throw new Error('Gemini API key not configured. Add it in Config -> Settings.');
      }
      const evalPrompts = await db.evalPrompts.toArray();
      const evalPrompt =
        evalPrompts.find((ep) => ep.id === currentBlock.evalPromptId) ??
        evalPrompts.find((ep) => ep.appliesToType === currentBlock.type) ??
        evalPrompts[0];
      if (!evalPrompt) throw new Error('No evaluation prompt found.');

      const verifiedDuration =
        resp?.audioDurationSec ?? (resp?.timeSpentSec && resp.timeSpentSec > 0 ? resp.timeSpentSec : currentBlock.durationSec);

      const feedback = await evaluateResponse({
        apiKey: settings.geminiApiKey,
        evalPromptTemplate: evalPrompt.promptText,
        variables: {
          prompt: resp?.promptSnapshot || currentBlock.instructions,
          response: studentText,
          transcript: resp?.timestampedTranscript || studentText,
          durationSec: String(verifiedDuration),
          wpm: String(resp?.wpm ?? 130),
          fillerCount: String(resp?.fillerCount ?? 0),
        },
      });

      updateResponse(currentBlock.id, {
        aiFeedback: feedback,
        aiOverallScore: feedback.overallScore,
        aiSubscores: feedback.subscores,
      });
    } catch (err) {
      setInstantEvalError(err instanceof Error ? err.message : 'Instant evaluation failed.');
    } finally {
      setInstantEvalLoading(false);
    }
  }, [currentBlock, draftResponses, pauseSession, updateResponse]);

  const handleAbandon = useCallback(async () => {
    if (window.confirm('Exit this practice session? Your draft responses remain saved in History.')) {
      await abandonSession();
    }
  }, [abandonSession]);

  if (!activeRun || !currentBlock) return null;

  const currentResponse = draftResponses[currentBlock.id];
  const blockFeedback = currentResponse?.aiFeedback;
  const isLowTime = blockTimeRemaining <= 60 && blockTimeRemaining > 0;
  const isCritical = blockTimeRemaining <= 10 && blockTimeRemaining > 0;
  const totalBlocks = activeRun.blockConfigs.length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
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
        <div className="flex items-center justify-between px-6 py-2.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleAbandon}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg cursor-pointer"
            >
              ← Exit
            </button>
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-md">
              Block {currentBlockIndex + 1} / {totalBlocks}
            </span>
            <span className="text-sm font-semibold text-slate-800">{currentBlock.name}</span>
            {lastSavedAt && <span className="text-xs text-slate-400 hidden sm:inline">Auto-saved</span>}
          </div>
          <div className="flex items-center gap-3">
            <WhisperLiveIndicator compact />
            <span className="text-xs text-slate-400 font-mono">Total {formatTime(overallElapsedSec)}</span>
            <span
              className={\`text-base font-bold font-mono tabular-nums px-2.5 py-0.5 rounded \${
                blockTimeRemaining === 0
                  ? 'bg-red-100 text-red-700'
                  : isCritical
                  ? 'bg-red-50 text-red-600 timer-warning'
                  : isLowTime
                  ? 'bg-amber-50 text-amber-600'
                  : 'text-slate-800'
              }\`}
            >
              {blockTimeRemaining === 0 ? 'TIME UP' : formatTime(blockTimeRemaining)}
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-3xl w-full mx-auto px-6 py-6 space-y-6">
        <BlockInputRouter block={currentBlock} />

        {instantEvalError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl p-3">
            {instantEvalError}
          </div>
        )}

        {/* Write-Critique-Rewrite / Noticing Hypothesis Feedback Drawer */}
        {blockFeedback && (
          <div className="bg-white border-2 border-primary-400 rounded-2xl p-5 shadow-md space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
                  Noticing Hypothesis Loop • Attempt #{currentResponse?.attemptCount ?? 1}
                </span>
                <h4 className="text-base font-bold text-slate-900">
                  Instant DET Calibration (Verified Duration: {currentResponse?.audioDurationSec ?? currentResponse?.timeSpentSec ?? 0}s)
                </h4>
              </div>
              <div className="text-right">
                <span className="text-3xl font-black text-primary-600">
                  {currentResponse?.aiOverallScore ?? '—'}
                </span>
                <span className="text-xs text-slate-400 block">/ 160</span>
              </div>
            </div>

            {blockFeedback.suggestedFix && (
              <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5">
                <p className="text-xs font-bold text-primary-800 mb-1">
                  145–155 Band Target Upgrade (Incorporate this into your next attempt):
                </p>
                <p className="text-xs text-slate-800 leading-relaxed">{blockFeedback.suggestedFix}</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {blockFeedback.strengths.length > 0 && (
                <div className="bg-green-50 rounded-lg p-3">
                  <p className="font-bold text-green-800 mb-1">Strengths</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.strengths.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blockFeedback.weaknesses.length > 0 && (
                <div className="bg-amber-50 rounded-lg p-3">
                  <p className="font-bold text-amber-800 mb-1">Gaps to Fix in Rewrite/Re-record</p>
                  <ul className="list-disc list-inside space-y-1 text-slate-700">
                    {blockFeedback.weaknesses.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => resetBlockForRewrite(currentBlock.id)}
                className="px-4 py-2 text-xs font-bold bg-primary-600 text-white rounded-lg hover:bg-primary-700 cursor-pointer shadow-xs"
              >
                {currentBlock.type === 'speaking' || currentBlock.type === 'shadowing'
                  ? '↻ Apply Fixes & Re-Record Now (Deliberate Practice)'
                  : '↻ Clear & Rewrite Using 150-Band Upgrade'}
              </button>
              <button
                type="button"
                onClick={resumeRunning}
                className="px-4 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                Resume Timer
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="sticky bottom-0 z-30 bg-white border-t border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={handleAbandon}
          className="text-xs font-medium text-slate-400 hover:text-red-600"
        >
          Exit Session
        </button>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleInstantCheck}
            disabled={instantEvalLoading}
            className="px-4 py-2 text-xs font-semibold text-accent-700 bg-accent-50 border border-accent-200 rounded-lg hover:bg-accent-100 disabled:opacity-50 cursor-pointer"
          >
            {instantEvalLoading ? 'Grading Block...' : 'Instant AI Feedback'}
          </button>
          <button
            type="button"
            onClick={isPaused ? resumeRunning : pauseSession}
            className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            {isPaused ? 'Resume Timer' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={handleDone}
            className="px-5 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            {isLastBlock ? 'Finish & Review Session →' : 'Next Block →'}
          </button>
        </div>
      </footer>

      {transitionCountdown !== null && (
        <TransitionOverlay
          count={transitionCountdown}
          nextBlockName={activeRun.blockConfigs[currentBlockIndex]?.name}
        />
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 9. POST-SESSION: Pass Timestamped Transcript & True Audio Duration
  // =========================================================================
  'src/components/exam/PostSession.tsx': `import { useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { db } from '../../db/database';
import { evaluateResponse } from '../../services/gemini';
import { formatTime } from '../../utils/helpers';
import type { BlockResponse, DETSkill } from '../../types';

export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun);
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun);
  const setView = useAppStore((s) => s.setView);
  const setConfigSection = useAppStore((s) => s.setConfigSection);

  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [localResponses, setLocalResponses] = useState<Record<string, BlockResponse>>(
    activeRun?.responses ?? {}
  );

  const handleUpdateText = (blockId: string, text: string) => {
    setLocalResponses((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], textOrTranscript: text, timestampedTranscript: text },
    }));
  };

  const handleEvaluate = useCallback(async () => {
    if (!activeRun) return;
    if (!navigator.onLine) {
      setQueuedOffline(true);
      setEvalError('You are currently offline. Responses are saved and will auto-evaluate when back online.');
      return;
    }
    setEvaluating(true);
    setEvalError(null);
    try {
      const settings = await db.settings.get('app-settings');
      if (!settings?.geminiApiKey) {
        setEvalError('Gemini API key not set. Go to Config -> Settings to paste your free Google AI Studio key.');
        setEvaluating(false);
        return;
      }
      const evalPrompts = await db.evalPrompts.toArray();
      const updatedResponses = { ...localResponses };
      const blockScores: number[] = [];
      const skillScores: Partial<Record<DETSkill, number[]>> = {};

      for (const block of activeRun.blockConfigs) {
        const response = updatedResponses[block.id];
        const text = response?.textOrTranscript?.trim() ?? '';
        if (!text) continue;
        const evalPrompt =
          evalPrompts.find((ep) => ep.id === block.evalPromptId) ??
          evalPrompts.find((ep) => ep.appliesToType === block.type) ??
          evalPrompts[0];
        if (!evalPrompt) continue;

        const verifiedDuration =
          response?.audioDurationSec ??
          (response?.timeSpentSec && response.timeSpentSec > 0 ? response.timeSpentSec : block.durationSec);

        const feedback = await evaluateResponse({
          apiKey: settings.geminiApiKey,
          evalPromptTemplate: evalPrompt.promptText,
          variables: {
            prompt: response?.promptSnapshot || block.instructions,
            response: text,
            transcript: response?.timestampedTranscript || text,
            durationSec: String(verifiedDuration),
            wpm: String(response?.wpm ?? 130),
            fillerCount: String(response?.fillerCount ?? 0),
          },
        });

        const subVals = Object.values(feedback.subscores);
        const computedScore =
          feedback.overallScore ??
          (subVals.length > 0
            ? Math.round(subVals.reduce((a, b) => a + b, 0) / subVals.length)
            : 125);
        blockScores.push(computedScore);

        const targetSkill: DETSkill =
          block.type === 'speaking' || block.type === 'shadowing'
            ? 'speaking'
            : block.type === 'dictogloss'
            ? 'listening'
            : block.type === 'mock-test'
            ? 'reading'
            : 'writing';
        skillScores[targetSkill] = [...(skillScores[targetSkill] ?? []), computedScore];

        updatedResponses[block.id] = {
          ...response,
          aiFeedback: feedback,
          aiOverallScore: computedScore,
          aiSubscores: feedback.subscores,
          evalPendingOffline: false,
        };
      }

      const compositeOverall =
        blockScores.length > 0
          ? Math.round(blockScores.reduce((a, b) => a + b, 0) / blockScores.length)
          : undefined;
      const perSkillScores: Partial<Record<DETSkill, number>> = {};
      for (const [sk, arr] of Object.entries(skillScores) as [DETSkill, number[]][]) {
        if (arr && arr.length > 0) {
          perSkillScores[sk] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
        }
      }

      setLocalResponses(updatedResponses);
      await db.sessionRuns.update(activeRun.id, {
        responses: updatedResponses,
        summary: {
          overallScore: compositeOverall,
          perSkillScores,
          durationSec: activeRun.overallElapsedSec,
        },
      });
      setQueuedOffline(false);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation failed.');
    } finally {
      setEvaluating(false);
    }
  }, [activeRun, localResponses]);

  useEffect(() => {
    if (!queuedOffline) return;
    const onOnline = () => void handleEvaluate();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [queuedOffline, handleEvaluate]);

  if (!activeRun) return null;

  const scoredValues = Object.values(localResponses)
    .map((r) => r.aiOverallScore)
    .filter((v): v is number => typeof v === 'number');
  const sessionAverage =
    scoredValues.length > 0
      ? Math.round(scoredValues.reduce((a, b) => a + b, 0) / scoredValues.length)
      : null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
            Session Complete
          </span>
          <h2 className="text-2xl font-bold text-slate-900 mt-0.5">{activeRun.templateName}</h2>
          <p className="text-xs text-slate-500 mt-1">
            Total Time: {formatTime(activeRun.overallElapsedSec)} • {activeRun.blockConfigs.length} Blocks
          </p>
        </div>
        {sessionAverage !== null ? (
          <div className="text-right bg-primary-50 border border-primary-200 px-5 py-3 rounded-xl">
            <span className="text-xs font-semibold text-primary-700 block">Estimated DET Band</span>
            <span className="text-4xl font-black text-primary-600">{sessionAverage}</span>
            <span className="text-xs text-primary-600"> / 160</span>
          </div>
        ) : (
          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="px-6 py-3 bg-primary-600 text-white text-sm font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 cursor-pointer"
          >
            {evaluating ? 'Grading with Gemini...' : 'Grade All Blocks with Gemini AI'}
          </button>
        )}
      </div>

      {evalError && (
        <div className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-4">
          {evalError}
        </div>
      )}

      <div className="space-y-6">
        {activeRun.blockConfigs.map((block, idx) => {
          const response = localResponses[block.id];
          const feedback = response?.aiFeedback;
          const score = response?.aiOverallScore;
          const verifiedSec = response?.audioDurationSec ?? response?.timeSpentSec ?? 0;
          return (
            <div key={block.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100">
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {idx + 1}. {block.name}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {block.type} • Verified Duration: {verifiedSec}s
                    {response?.wpm ? \` • \${response.wpm} WPM\` : ''}
                    {response?.fillerCount !== undefined ? \` • \${response.fillerCount} fillers\` : ''}
                    {response?.attemptCount && response.attemptCount > 1 ? \` • \${response.attemptCount} attempts\` : ''}
                  </p>
                </div>
                {score !== undefined && (
                  <div className="text-right">
                    <span className="text-2xl font-black text-primary-600">{score}</span>
                    <span className="text-xs text-slate-400 block">/ 160</span>
                  </div>
                )}
              </div>
              <div className="p-5 space-y-4">
                {response?.audioBlobRef && (
                  <audio controls src={response.audioBlobRef} className="w-full h-10" />
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    Response / Timestamped Verbatim Transcript:
                  </label>
                  <textarea
                    value={response?.timestampedTranscript || response?.textOrTranscript || ''}
                    onChange={(e) => handleUpdateText(block.id, e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs font-mono text-slate-800"
                  />
                </div>
                {feedback?.suggestedFix && (
                  <div className="bg-primary-50 border border-primary-200 rounded-xl p-3.5 text-xs">
                    <p className="font-bold text-primary-800 mb-1">145–155 Band Suggested Upgrade:</p>
                    <p className="text-slate-800">{feedback.suggestedFix}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex flex-wrap justify-between items-center gap-3">
        <button
          onClick={handleEvaluate}
          disabled={evaluating}
          className="px-4 py-2 text-sm font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg"
        >
          {evaluating ? 'Re-evaluating...' : 'Re-evaluate Responses with AI'}
        </button>
        <div className="flex gap-3">
          <button
            onClick={() => clearActiveRun()}
            className="px-4 py-2.5 text-sm font-semibold text-slate-700 border border-slate-300 rounded-lg"
          >
            Start Another Session
          </button>
          <button
            onClick={() => {
              clearActiveRun();
              setConfigSection('history');
              setView('config');
            }}
            className="px-5 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg"
          >
            View Score Trends & Error Log
          </button>
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 10.TEMPLATE & EVAL PROMPT EDITORS: Support Shadowing & Dictogloss Types
  // =========================================================================
  'src/components/config/EvalPromptEditor.tsx': `import { useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import type { EvalPrompt, BlockType, ScoreScale } from '../../types';
import { generateId } from '../../utils/helpers';

export function EvalPromptEditor() {
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const saveEvalPrompt = useConfigStore((s) => s.saveEvalPrompt);
  const deleteEvalPrompt = useConfigStore((s) => s.deleteEvalPrompt);
  const [editing, setEditing] = useState<EvalPrompt | null>(null);

  const blockTypes: { value: BlockType; label: string }[] = [
    { value: 'brain-dump', label: 'Brain Dump' },
    { value: 'vocab-writing', label: 'Collocation Chunk Writing' },
    { value: 'speaking', label: 'Timestamped Speaking' },
    { value: 'shadowing', label: 'Arguelles Shadowing' },
    { value: 'dictogloss', label: 'Dictogloss Reconstruction' },
    { value: 'mock-test', label: 'Mock Test' },
    { value: 'custom', label: 'Custom' },
  ];

  const handleNew = () => {
    setEditing({
      id: generateId(),
      name: 'New Eval Prompt',
      appliesToType: 'vocab-writing',
      promptText: '',
      scoreScale: 'det-0-160',
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    await saveEvalPrompt(editing);
    setEditing(null);
  };

  const templateVars = [
    '{{prompt}}',
    '{{response}}',
    '{{transcript}}',
    '{{durationSec}}',
    '{{fillerCount}}',
    '{{wpm}}',
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Evaluation Prompts</h2>
          <p className="text-sm text-slate-500 mt-1">
            Customize the AI rubrics used to score your responses
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700"
        >
          + New Prompt
        </button>
      </div>

      {!editing && (
        <div className="space-y-3">
          {evalPrompts.map((ep) => (
            <div key={ep.id} className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">{ep.name}</h3>
                  <span className="text-xs bg-accent-100 text-accent-700 px-2 py-0.5 rounded">
                    {ep.appliesToType}
                  </span>
                  <p className="text-xs text-slate-500 mt-2 line-clamp-2 font-mono">
                    {ep.promptText.slice(0, 150)}...
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing({ ...ep })}
                    className="px-2 py-1 text-xs text-primary-600 hover:bg-primary-50 rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteEvalPrompt(ep.id)}
                    className="px-2 py-1 text-xs text-danger-500 hover:bg-red-50 rounded"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Applies To</label>
              <select
                value={editing.appliesToType}
                onChange={(e) =>
                  setEditing({ ...editing, appliesToType: e.target.value as BlockType })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {blockTypes.map((bt) => (
                  <option key={bt.value} value={bt.value}>
                    {bt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Score Scale</label>
              <select
                value={editing.scoreScale}
                onChange={(e) =>
                  setEditing({ ...editing, scoreScale: e.target.value as ScoreScale })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                <option value="det-0-160">DET (0–160)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Available variables:</span>
            {templateVars.map((v) => (
              <code key={v} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                {v}
              </code>
            ))}
          </div>

          <textarea
            value={editing.promptText}
            onChange={(e) => setEditing({ ...editing, promptText: e.target.value })}
            rows={14}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono mb-4"
          />

          <div className="flex justify-end gap-3">
            <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-slate-600">
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg"
            >
              Save Prompt
            </button>
          </div>
        </div>
      )}
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
  console.log('Phase 2 Updated:', path.relative(cwd, targetPath));
}
console.log('\nPhase 2 (All 6 SLA Deliberate Practice Features & UI) applied successfully!');