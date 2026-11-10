// upgrade-21day-phase2-blocks-and-chunks.mjs
// Phase 2 of 3: Dynamic 15-Set Collocation Chunk Switcher + Live Chunk Detection
// + Automatic Unseen-First Question Selection & Completion Marking across all blocks.
// Run from project root: node upgrade-21day-phase2-blocks-and-chunks.mjs

import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. VOCAB & COLLOCATION WRITING BLOCK: Dynamic 4-Chunk Pills + Live Detection
  // =========================================================================
  'src/components/exam/blocks/VocabWritingBlock.tsx': `import { useCallback, useEffect, useState, useMemo } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import { initSRS, reviewItem } from '../../../utils/srs';
import {
  getAdaptiveQuestions,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';

function formatPromptWithChunks(q: QuestionBankItem | null, fallback: string): string {
  if (!q) return fallback;
  const chunks = q.targetChunks ?? [];
  if (chunks.length === 0) return q.prompt;
  return \`\${q.prompt}\\nRequired Collocation Chunks: \${chunks.map((c) => \`"\${c}"\`).join(', ')}\`;
}

export function VocabWritingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [gradedMessage, setGradedMessage] = useState<string | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  const loadCollocationSets = useCallback(async () => {
    const { selected, completedIds: doneSet } = await getAdaptiveQuestions({
      skill: 'writing',
      questionType: 'write-about-photo',
      limit: 30,
    });

    // Ensure items with targetChunks appear first, with unseen items at the very top
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
          questionType: chosen.type,
          promptSnapshot: formatPromptWithChunks(chosen, block.instructions),
        });
      }
    }
  }, [block.id, block.instructions, block.questionSetId, response?.questionId, updateResponse]);

  useEffect(() => {
    void loadCollocationSets();
  }, [loadCollocationSets]);

  const activeQuestion = questions[selectedIdx] ?? null;
  const activeChunks = useMemo(
    () => activeQuestion?.targetChunks ?? [],
    [activeQuestion]
  );

  // Check which of the 4 target chunks appear in the student's text (case-insensitive)
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

  const handleSelectQuestionIndex = (nextIdx: number) => {
    const nextQ = questions[nextIdx];
    if (!nextQ) return;
    setSelectedIdx(nextIdx);
    updateResponse(block.id, {
      questionId: nextQ.id,
      questionType: nextQ.type,
      promptSnapshot: formatPromptWithChunks(nextQ, block.instructions),
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

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
      updateResponse(block.id, {
        textOrTranscript: val,
        promptSnapshot: formatPromptWithChunks(activeQuestion, block.instructions),
        questionId: activeQuestion?.id,
        questionType: activeQuestion?.type ?? 'write-about-photo',
      });
      if (wc >= 40 && activeQuestion && !completedIds.has(activeQuestion.id)) {
        void markQuestionCompleted(activeQuestion.id);
        setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
      }
    },
    [activeQuestion, block.id, block.instructions, completedIds, updateResponse]
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
    setGradedMessage(\`✓ Marked Done & SRS Updated (\${label}): Next review in \${updatedSrs.intervalDays}d\`);
    setTimeout(() => setGradedMessage(null), 3500);
  };

  const unseenRemaining = questions.filter((q) => !completedIds.has(q.id)).length;

  return (
    <div className="space-y-4">
      {/* Top Bar: Unseen Counter, Set Dropdown, Next Unseen Button & SRS Recall */}
      {questions.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-primary-100 text-primary-800">
              ✨ {unseenRemaining} of {questions.length} Unseen Sets Remaining
            </span>

            <select
              value={selectedIdx}
              onChange={(e) => handleSelectQuestionIndex(Number(e.target.value))}
              className="text-xs font-semibold border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-primary-400 max-w-xs sm:max-w-md"
            >
              {questions.map((q, idx) => {
                const isDone = completedIds.has(q.id);
                return (
                  <option key={q.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {q.dayNumber ? \`Day \${q.dayNumber}: \` : \`Set #\${idx + 1}: \`}
                    {q.sourceAttribution?.replace('DET C1/C2 Collocation Bank — ', '') ||
                      q.prompt.slice(0, 48)}
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

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 mr-1">SRS Recall:</span>
            <button
              type="button"
              onClick={() => handleRateSRS(2, 'Again')}
              className="px-2.5 py-1 text-xs font-semibold bg-red-50 text-red-700 rounded hover:bg-red-100 cursor-pointer"
            >
              Again (1d)
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(4, 'Good')}
              className="px-2.5 py-1 text-xs font-semibold bg-blue-50 text-blue-700 rounded hover:bg-blue-100 cursor-pointer"
            >
              Good
            </button>
            <button
              type="button"
              onClick={() => handleRateSRS(5, 'Easy')}
              className="px-2.5 py-1 text-xs font-semibold bg-green-50 text-green-700 rounded hover:bg-green-100 cursor-pointer"
            >
              Easy
            </button>
          </div>
        </div>
      )}

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
              {activeQuestion?.sourceAttribution || 'DET C1/C2 Collocation Drill'}
            </span>
            {activeQuestion?.dayNumber && (
              <span className="text-xs font-mono font-bold text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                Plan Day {activeQuestion.dayNumber}
              </span>
            )}
          </div>
          {activeChunks.length > 0 && (
            <span
              className={\`text-xs font-bold px-2.5 py-1 rounded-full \${
                usedChunksCount === activeChunks.length
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-accent-800 border border-accent-300'
              }\`}
            >
              Collocations Used: {usedChunksCount} / {activeChunks.length}
            </span>
          )}
        </div>

        <p className="text-base text-slate-900 leading-relaxed font-semibold">
          {activeQuestion?.prompt || block.instructions}
        </p>

        {/* Dynamic Collocation Pills (Updates whenever activeQuestion changes!) */}
        {activeChunks.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-bold text-slate-600">
              Target Multi-Word Collocation Chunks (type each phrase naturally in your paragraph below):
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
                      {isUsed ? '✓ Used' : 'Pending'}
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
              Show Reference 150-Band Sample Paragraph
            </summary>
            <p className="mt-2 p-3 bg-white rounded-xl border border-accent-200 italic leading-relaxed">
              {activeQuestion.sampleAnswer}
            </p>
          </details>
        )}
      </div>

      {/* Writing Area */}
      <div>
        <textarea
          value={text}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          placeholder="Write your cohesive academic paragraph here incorporating all 4 target collocation chunks..."
          className="w-full min-h-[260px] p-4 text-base text-slate-800 bg-white border-2 border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-accent-500 leading-relaxed"
          spellCheck
          autoFocus
        />
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-slate-500">
          <span>
            Aim for 65–110 words with complex subordination (whereas, although, consequently)
          </span>
          <div className="flex items-center gap-3">
            <span className={wordCount >= 65 ? 'text-green-600 font-bold' : 'font-mono'}>
              {wordCount} {wordCount === 1 ? 'word' : 'words'} {wordCount >= 65 ? '✓' : '/ 65+'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
`,

  // =========================================================================
  // 2. INTERACTIVE READING BLOCK: Unseen-First Sorting + Completion Marking
  // =========================================================================
  'src/components/exam/blocks/InteractiveReadingBlock.tsx': `import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db, ensureDatabaseUpgraded } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem, ReadAndCompleteBlank } from '../../../types';

const STEP_LABELS = [
  '1. Complete the Sentences',
  '2. Complete the Passage',
  '3. Highlight the Answer #1',
  '4. Highlight the Answer #2',
  '5. Identify the Idea',
  '6. Title the Passage',
];

function SegmentedWordBlank({
  blank,
  value,
  submitted,
  onChange,
}: {
  blank: ReadAndCompleteBlank;
  value: string;
  submitted: boolean;
  onChange: (newVal: string) => void;
}) {
  const len = blank.missingSuffix.length;
  const boxRefs = useRef<(HTMLInputElement | null)[]>([]);

  const chars = Array.from({ length: len }, (_, i) => value[i] ?? '');
  const isCorrect =
    submitted && value.trim().toLowerCase() === blank.missingSuffix.toLowerCase();
  const isWrong =
    submitted && value.trim().toLowerCase() !== blank.missingSuffix.toLowerCase();

  const updateCharAt = (index: number, char: string) => {
    const next = [...chars];
    next[index] = char;
    onChange(next.join(''));
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (chars[index]) {
        updateCharAt(index, '');
      } else if (index > 0) {
        updateCharAt(index - 1, '');
        boxRefs.current[index - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      boxRefs.current[index - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && index < len - 1) {
      e.preventDefault();
      boxRefs.current[index + 1]?.focus();
      return;
    }
  };

  const handleInput = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (!raw) {
      updateCharAt(index, '');
      return;
    }
    const clean = raw.replace(/[^a-zA-Z-]/g, '');
    if (!clean) return;

    if (clean.length === 1) {
      updateCharAt(index, clean);
      if (index < len - 1) {
        boxRefs.current[index + 1]?.focus();
      }
    } else {
      const next = [...chars];
      for (let i = 0; i < clean.length && index + i < len; i++) {
        next[index + i] = clean[i];
      }
      onChange(next.join(''));
      const nextFocus = Math.min(len - 1, index + clean.length);
      boxRefs.current[nextFocus]?.focus();
    }
  };

  return (
    <span className="inline-flex items-center mx-1 my-0.5 align-baseline">
      <span className="font-bold text-slate-900 font-mono text-base px-1 py-0.5 bg-slate-200/80 rounded-l-md border border-r-0 border-slate-300">
        {blank.prefix}
      </span>

      <span className="inline-flex items-center">
        {chars.map((ch, i) => (
          <input
            key={i}
            ref={(el) => {
              boxRefs.current[i] = el;
            }}
            type="text"
            inputMode="text"
            maxLength={2}
            value={ch}
            onChange={(e) => handleInput(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={\`\${blank.prefix} letter \${i + 1} of \${len}\`}
            className={\`w-6 h-7 text-center font-mono text-sm font-bold border border-r-0 last:border-r last:rounded-r-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:z-10 transition-colors \${
              isCorrect
                ? 'bg-green-100 border-green-500 text-green-900'
                : isWrong
                ? 'bg-red-50 border-red-400 text-red-800'
                : ch
                ? 'bg-primary-50 border-primary-400 text-primary-900'
                : 'bg-white border-slate-300 text-slate-800'
            }\`}
          />
        ))}
      </span>

      {isWrong && (
        <span className="ml-1.5 text-xs font-mono font-bold text-green-800 bg-green-100 px-1.5 py-0.5 rounded">
          ✓ {blank.fullWord}
        </span>
      )}
    </span>
  );
}

export function InteractiveReadingBlock({
  block,
  forcedMode,
}: {
  block: BlockConfig;
  forcedMode?: 'interactive-reading' | 'read-and-complete';
}) {
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const initialMode: 'interactive-reading' | 'read-and-complete' =
    forcedMode ??
    (block.preferredQuestionType === 'interactive-reading'
      ? 'interactive-reading'
      : 'read-and-complete');

  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'interactive-reading' | 'read-and-complete'>(initialMode);
  const [currentIdx, setCurrentIdx] = useState(0);

  const [step, setStep] = useState(0);
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [selectedGapSentence, setSelectedGapSentence] = useState<string>('');
  const [highlighted1, setHighlighted1] = useState<string>('');
  const [highlighted2, setHighlighted2] = useState<string>('');
  const [selectedIdea, setSelectedIdea] = useState<string>('');
  const [selectedTitle, setSelectedTitle] = useState<string>('');
  const [submittedReading, setSubmittedReading] = useState(false);

  const [prefixInputs, setPrefixInputs] = useState<Record<string, string>>({});
  const [submittedCloze, setSubmittedCloze] = useState(false);
  const [lastClozeScore, setLastClozeScore] = useState<{
    earned: number;
    total: number;
    detScore: number;
  } | null>(null);

  useEffect(() => {
    if (forcedMode) {
      setMode(forcedMode);
    } else if (
      block.preferredQuestionType === 'interactive-reading' ||
      block.preferredQuestionType === 'read-and-complete'
    ) {
      setMode(block.preferredQuestionType);
    }
  }, [forcedMode, block.preferredQuestionType]);

  useEffect(() => {
    void ensureDatabaseUpgraded().then(async () => {
      const [all, doneSet] = await Promise.all([
        db.questionBank.toArray(),
        getCompletedQuestionIds(),
      ]);
      setCompletedIds(doneSet);

      const readingItems = all.filter(
        (q) =>
          q.skill === 'reading' &&
          (q.type === 'interactive-reading' || q.type === 'read-and-complete')
      );

      // Sort UNSEEN passages first, then by assigned 21-day plan dayNumber
      readingItems.sort((a, b) => {
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return (a.dayNumber ?? 99) - (b.dayNumber ?? 99);
      });

      setQuestions(readingItems);

      if (block.questionSetId) {
        const pinned = readingItems.find((q) => q.id === block.questionSetId);
        if (
          pinned &&
          (pinned.type === 'read-and-complete' || pinned.type === 'interactive-reading')
        ) {
          setMode(pinned.type);
          const subset = readingItems.filter((q) => q.type === pinned.type);
          const idx = subset.findIndex((q) => q.id === pinned.id);
          if (idx >= 0) setCurrentIdx(idx);
        }
      }
    });
  }, [block.questionSetId]);

  const filteredList = useMemo(
    () => questions.filter((q) => q.type === mode),
    [questions, mode]
  );

  const activeItem = filteredList[currentIdx] ?? null;
  const ir = activeItem?.interactiveReading;
  const rc = activeItem?.readAndComplete;

  const resetStates = () => {
    setStep(0);
    setClozeAnswers({});
    setSelectedGapSentence('');
    setHighlighted1('');
    setHighlighted2('');
    setSelectedIdea('');
    setSelectedTitle('');
    setSubmittedReading(false);
    setPrefixInputs({});
    setSubmittedCloze(false);
    setLastClozeScore(null);
  };

  const handleSwitchPassage = (nextIndex: number) => {
    setCurrentIdx(nextIndex);
    resetStates();
  };

  const handleJumpToNextUnseenPassage = () => {
    const nextUnseenIdx = filteredList.findIndex(
      (q, i) => i !== currentIdx && !completedIds.has(q.id)
    );
    if (nextUnseenIdx >= 0) {
      handleSwitchPassage(nextUnseenIdx);
    } else if (filteredList.length > 1) {
      handleSwitchPassage((currentIdx + 1) % filteredList.length);
    }
  };

  const handleGradeInteractiveReading = () => {
    if (!ir || !activeItem) return;
    let earned = 0;
    const totalPossible = ir.blanks.length + 5;
    const wrongDetails: string[] = [];
    const rightDetails: string[] = [];

    for (const b of ir.blanks) {
      if (clozeAnswers[b.id] === b.correctAnswer) {
        earned += 1;
      } else {
        wrongDetails.push(
          \`Blank [\${b.id}]: chose "\${clozeAnswers[b.id] || 'none'}" (Correct: "\${b.correctAnswer}")\`
        );
      }
    }
    if (earned === ir.blanks.length) {
      rightDetails.push('Perfect lexical precision on Complete the Sentences.');
    }

    if (selectedGapSentence === ir.correctPassageGap) {
      earned += 1;
      rightDetails.push('Correctly bridged discourse transition in Complete the Passage.');
    } else {
      wrongDetails.push('Missed discourse transition sentence in Step 2 (Complete the Passage).');
    }

    if (highlighted1.trim() === ir.correctHighlight1.trim()) {
      earned += 1;
      rightDetails.push('Pinpointed exact factual evidence in Highlight the Answer #1.');
    } else {
      wrongDetails.push('Inaccurate sentence selection on Highlight the Answer #1.');
    }

    if (highlighted2.trim() === ir.correctHighlight2.trim()) {
      earned += 1;
      rightDetails.push('Pinpointed exact factual evidence in Highlight the Answer #2.');
    } else {
      wrongDetails.push('Inaccurate sentence selection on Highlight the Answer #2.');
    }

    if (selectedIdea === ir.correctMainIdea) {
      earned += 1;
      rightDetails.push('Identified primary macro-thesis of the passage.');
    } else {
      wrongDetails.push('Missed main idea synthesis in Identify the Idea.');
    }

    if (selectedTitle === ir.correctTitle) {
      earned += 1;
    } else {
      wrongDetails.push('Selected suboptimal academic title.');
    }

    const accuracy = earned / Math.max(1, totalPossible);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedReading(true);

    // Mark completed so it never repeats automatically!
    void markQuestionCompleted(activeItem.id);
    setCompletedIds((prev) => new Set(prev).add(activeItem.id));

    const summaryTranscript = [
      \`[Interactive Reading — \${ir.sourceName}]\`,
      \`Accuracy: \${earned}/\${totalPossible} (\${Math.round(accuracy * 100)}%) -> Estimated DET Band: \${detScore}/160\`,
      wrongDetails.length > 0
        ? \`Mistakes: \${wrongDetails.join(' | ')}\`
        : 'Zero errors across all 6 steps!',
    ].join('\\n');

    updateResponse(block.id, {
      questionId: activeItem.id,
      questionType: 'interactive-reading',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(65, detScore - 5),
        production: Math.max(65, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: { literacy: detScore, comprehension: detScore },
        criteria: {
          reading_accuracy: \`\${earned} / \${totalPossible} items correct\`,
          source: ir.sourceName,
        },
        strengths:
          rightDetails.length > 0 ? rightDetails : ['Completed interactive reading passage'],
        weaknesses: wrongDetails,
        suggestions: [
          'Pay close attention to discourse markers (however, consequently, whereas) when bridging paragraphs.',
        ],
      },
    });
  };

  const handleGradeReadAndComplete = () => {
    if (!rc || !activeItem) return;
    let earned = 0;
    const total = rc.blanks.length;
    const missedWords: string[] = [];

    for (const b of rc.blanks) {
      const userSuffix = (prefixInputs[b.id] ?? '').trim().toLowerCase();
      if (userSuffix === b.missingSuffix.toLowerCase()) {
        earned += 1;
      } else {
        missedWords.push(\`\${b.prefix}[\${b.missingSuffix}] (you typed: "\${b.prefix}\${userSuffix}")\`);
      }
    }

    const accuracy = earned / Math.max(1, total);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedCloze(true);
    setLastClozeScore({ earned, total, detScore });

    // Mark completed in DB so next session automatically loads a new unseen passage!
    void markQuestionCompleted(activeItem.id);
    setCompletedIds((prev) => new Set(prev).add(activeItem.id));

    const summaryTranscript = \`[Read and Complete — \${rc.sourceName}] Score: \${earned}/\${total} (\${detScore}/160). \${
      missedWords.length > 0
        ? 'Missed: ' + missedWords.join(', ')
        : 'All words completed accurately!'
    }\`;

    updateResponse(block.id, {
      questionId: activeItem.id,
      questionType: 'read-and-complete',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: { literacy: detScore, comprehension: detScore },
        criteria: { lexical_cloze: \`\${earned}/\${total} correct\` },
        strengths:
          earned >= total - 2
            ? ['Strong orthographic & collocation recall']
            : ['Completed C-test passage'],
        weaknesses: missedWords,
        suggestions: [
          'Look at grammatical suffixes (-tion, -ive, -ly) and exact letter box counts.',
        ],
      },
    });
  };

  const renderParagraphWithDropdowns = () => {
    if (!ir) return null;
    const parts = ir.paragraph1WithBlanks.split(/(\\{\\{\\d+\\}\\})/g);
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-8">
        {parts.map((part, i) => {
          const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
          if (!match) return <span key={i}>{part}</span>;
          const blankId = match[1];
          const blankObj = ir.blanks.find((b) => b.id === blankId);
          if (!blankObj) return <span key={i}>{part}</span>;
          const val = clozeAnswers[blankId] ?? '';
          const isCorrect = submittedReading && val === blankObj.correctAnswer;
          const isWrong = submittedReading && val !== blankObj.correctAnswer;
          return (
            <span key={i} className="inline-block mx-1">
              <select
                value={val}
                onChange={(e) =>
                  setClozeAnswers((prev) => ({ ...prev, [blankId]: e.target.value }))
                }
                className={\`px-2.5 py-1 text-sm font-bold rounded-lg border-2 transition-colors cursor-pointer \${
                  isCorrect
                    ? 'bg-green-100 border-green-500 text-green-900'
                    : isWrong
                    ? 'bg-red-100 border-red-500 text-red-900'
                    : val
                    ? 'bg-primary-50 border-primary-500 text-primary-900'
                    : 'bg-amber-50 border-amber-300 text-slate-700'
                }\`}
              >
                <option value="">[{blankId}] Select word...</option>
                {blankObj.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {isWrong && (
                <span className="ml-1 text-xs font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                  ✓ {blankObj.correctAnswer}
                </span>
              )}
            </span>
          );
        })}
      </p>
    );
  };

  const renderClickableSentences = (sentences: string[], isHighlightStep: boolean) => {
    const activeSelection = step === 2 ? highlighted1 : step === 3 ? highlighted2 : '';
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-7">
        {sentences.map((sentence, idx) => {
          const isSelected = activeSelection.trim() === sentence.trim();
          return (
            <span
              key={idx}
              onClick={() => {
                if (!isHighlightStep) return;
                if (step === 2) setHighlighted1(sentence);
                if (step === 3) setHighlighted2(sentence);
              }}
              className={\`inline transition-colors rounded px-1 py-0.5 \${
                isHighlightStep
                  ? isSelected
                    ? 'bg-amber-200 text-slate-900 font-semibold ring-2 ring-amber-400 cursor-pointer'
                    : 'hover:bg-primary-100 cursor-pointer'
                  : ''
              }\`}
            >
              {sentence}{' '}
            </span>
          );
        })}
      </p>
    );
  };

  const rcList = questions.filter((q) => q.type === 'read-and-complete');
  const irList = questions.filter((q) => q.type === 'interactive-reading');
  const unseenInMode = filteredList.filter((q) => !completedIds.has(q.id)).length;

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('read-and-complete');
              const firstUnseen = rcList.findIndex((q) => !completedIds.has(q.id));
              setCurrentIdx(firstUnseen >= 0 ? firstUnseen : 0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            ✍️ Read and Complete ({rcList.filter((q) => !completedIds.has(q.id)).length}/{rcList.length} Unseen)
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('interactive-reading');
              const firstUnseen = irList.findIndex((q) => !completedIds.has(q.id));
              setCurrentIdx(firstUnseen >= 0 ? firstUnseen : 0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            📖 Interactive Reading ({irList.filter((q) => !completedIds.has(q.id)).length}/{irList.length} Unseen)
          </button>
        </div>

        {filteredList.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-1 rounded-full">
              ✨ {unseenInMode} Unseen Left
            </span>
            <select
              value={currentIdx}
              onChange={(e) => handleSwitchPassage(Number(e.target.value))}
              className="text-xs font-semibold text-slate-800 border border-slate-300 rounded-lg px-2.5 py-1.5 bg-slate-50 max-w-xs"
            >
              {filteredList.map((item, idx) => {
                const isDone = completedIds.has(item.id);
                return (
                  <option key={item.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {item.dayNumber ? \`Day \${item.dayNumber}: \` : \`#\${idx + 1}: \`}
                    {item.readAndComplete?.title || item.prompt.slice(0, 42)}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={handleJumpToNextUnseenPassage}
              className="px-3 py-1.5 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Next Unseen →
            </button>
          </div>
        )}
      </div>

      {mode === 'read-and-complete' && rc && (
        <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                  Type the missing letters • {rc.sourceName}
                </span>
                {activeItem?.dayNumber && (
                  <span className="text-xs font-mono font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                    Plan Day {activeItem.dayNumber}
                  </span>
                )}
              </div>
              <h3 className="text-lg font-bold text-slate-900 mt-1.5">{rc.title}</h3>
            </div>

            <div className="flex items-center gap-2">
              {lastClozeScore && (
                <span className="text-xs font-bold bg-green-100 text-green-800 border border-green-300 px-3 py-1.5 rounded-lg">
                  Score: {lastClozeScore.earned}/{lastClozeScore.total} • Band {lastClozeScore.detScore}/160
                </span>
              )}
              <button
                type="button"
                onClick={handleGradeReadAndComplete}
                className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer shadow-2xs"
              >
                ✓ Check Answers
              </button>
              {submittedCloze && filteredList.length > 1 && (
                <button
                  type="button"
                  onClick={handleJumpToNextUnseenPassage}
                  className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Next Unseen Passage →
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Each small box represents <strong>one missing letter</strong>. Typing a letter automatically moves to the next box (use Backspace to go back):
          </p>

          <div className="text-base text-slate-800 leading-10 bg-slate-50 p-6 rounded-xl border border-slate-200">
            {rc.passageWithBlanks.split(/(\\{\\{\\d+\\}\\})/g).map((part, idx) => {
              const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
              if (!match) return <span key={idx}>{part}</span>;
              const bId = match[1];
              const blank = rc.blanks.find((b) => b.id === bId);
              if (!blank) return <span key={idx}>{part}</span>;

              return (
                <SegmentedWordBlank
                  key={\`\${activeItem?.id}-\${bId}\`}
                  blank={blank}
                  value={prefixInputs[bId] ?? ''}
                  submitted={submittedCloze}
                  onChange={(newVal) =>
                    setPrefixInputs((prev) => ({ ...prev, [bId]: newVal }))
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      {mode === 'interactive-reading' && ir && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {STEP_LABELS.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => setStep(idx)}
                className={\`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer \${
                  step === idx
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }\`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border-2 border-slate-200 rounded-2xl p-5 space-y-4 shadow-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span className="text-xs font-bold uppercase tracking-wider text-primary-700 bg-primary-50 px-2.5 py-1 rounded">
                  Source: {ir.sourceName}
                </span>
                {(step === 2 || step === 3) && (
                  <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2.5 py-1 rounded animate-pulse">
                    Click a sentence below to highlight your answer
                  </span>
                )}
              </div>

              {step === 0
                ? renderParagraphWithDropdowns()
                : renderClickableSentences(ir.paragraph1Sentences, step === 2 || step === 3)}

              {step >= 1 && (
                <div
                  className={\`p-3 rounded-xl border-2 text-sm font-medium transition-all \${
                    selectedGapSentence
                      ? submittedReading
                        ? selectedGapSentence === ir.correctPassageGap
                          ? 'bg-green-50 border-green-400 text-green-900'
                          : 'bg-red-50 border-red-400 text-red-900'
                        : 'bg-primary-50 border-primary-400 text-slate-900'
                      : 'bg-amber-50/70 border-dashed border-amber-400 text-amber-800 italic'
                  }\`}
                >
                  {selectedGapSentence ||
                    '[Step 2 Gap: Select the best transitional sentence on the right to bridge these two paragraphs...]'}
                </div>
              )}

              {step >= 1 &&
                renderClickableSentences(ir.paragraph2Sentences, step === 2 || step === 3)}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between space-y-4 shadow-xs">
              <div className="space-y-4">
                <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                  {STEP_LABELS[step]}
                </span>

                {step === 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best word for each blank in the passage on the left.
                    </h4>
                    <div className="space-y-2 pt-2">
                      {ir.blanks.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between text-xs bg-slate-50 p-2.5 rounded-lg border border-slate-200"
                        >
                          <span className="font-bold text-slate-700">Blank [{b.id}]:</span>
                          <span className="font-semibold text-primary-700">
                            {clozeAnswers[b.id] || 'Not selected yet'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {step === 1 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best sentence to fill in the blank between the two paragraphs.
                    </h4>
                    <div className="space-y-2">
                      {ir.passageGapOptions.map((opt) => {
                        const chosen = selectedGapSentence === opt;
                        const isRight = submittedReading && opt === ir.correctPassageGap;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedGapSentence(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the question below:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion1}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted1 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted1.trim() !== ir.correctHighlight1.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight1}
                      </div>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the second question:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion2}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted2 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted2.trim() !== ir.correctHighlight2.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight2}
                      </div>
                    )}
                  </div>
                )}

                {step === 4 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the idea that is expressed in the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.mainIdeaOptions.map((opt) => {
                        const chosen = selectedIdea === opt;
                        const isRight = submittedReading && opt === ir.correctMainIdea;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedIdea(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 5 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best title for the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.titleOptions.map((opt) => {
                        const chosen = selectedTitle === opt;
                        const isRight = submittedReading && opt === ir.correctTitle;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedTitle(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  disabled={step === 0}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg disabled:opacity-40 cursor-pointer"
                >
                  ← Previous Step
                </button>
                {step < 5 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => Math.min(5, s + 1))}
                    className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
                  >
                    Next Step ({step + 2}/6) →
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleGradeInteractiveReading}
                      className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer shadow-xs"
                    >
                      ✓ Check All 6 Answers
                    </button>
                    {submittedReading && filteredList.length > 1 && (
                      <button
                        type="button"
                        onClick={handleJumpToNextUnseenPassage}
                        className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                      >
                        Next Unseen →
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 3. SPEAKING BLOCK: Unseen-First Speaking Prompts + Completion Tracking
  // =========================================================================
  'src/components/exam/blocks/SpeakingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
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
                    {p.dayNumber ? \`Day \${p.dayNumber}: \` : \`#\${idx + 1}: \`}
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
            {activePromptItem?.dayNumber ? \` • Plan Day \${activePromptItem.dayNumber}\` : ''}
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
                style={{ height: \`\${Math.max(6, level)}%\` }}
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
                className={\`text-lg font-bold \${
                  speechStats.wpm >= 115 && speechStats.wpm <= 165
                    ? 'text-green-600'
                    : 'text-amber-600'
                }\`}
              >
                {speechStats.wpm} WPM
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Fillers ("uh/um")</p>
              <p
                className={\`text-lg font-bold \${
                  speechStats.fillerCount <= 2 ? 'text-green-600' : 'text-red-600'
                }\`}
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
`,

  // =========================================================================
  // 4. SHADOWING BLOCK: Unseen-First Sorting + Completion Marking
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
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
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
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
    const [all, doneSet] = await Promise.all([
      db.questionBank.toArray(),
      getCompletedQuestionIds(),
    ]);
    setCompletedIds(doneSet);

    let manifest: Record<string, { audioUrl: string; text: string }> = {};
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
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

    // Sort UNSEEN items first, then by human audio availability
    shadowItems.sort((a, b) => {
      const aDone = doneSet.has(a.id) ? 1 : 0;
      const bDone = doneSet.has(b.id) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const aAudio = a.audioUrl ? 2 : a.youtubeSource ? 1 : 0;
      const bAudio = b.audioUrl ? 2 : b.youtubeSource ? 1 : 0;
      return bAudio - aAudio;
    });

    const finalList = shadowItems.length > 0 ? shadowItems : updatedItems;
    setPassages(finalList);

    if (block.questionSetId) {
      const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
      if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
    } else {
      const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
      if (firstUnseen >= 0) setSelectedIdx(firstUnseen);
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
    'Restoring native wetland corridors along municipal riverbanks not only absorbs seasonal floodwaters before they inundate residential neighborhoods, but also re-establishes critical stopover habitats for migratory songbirds.';

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

      if (currentItem?.id) {
        void markQuestionCompleted(currentItem.id);
        setCompletedIds((prev) => new Set(prev).add(currentItem.id));
      }

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
            className={\`text-xs font-bold px-2.5 py-1 rounded-full \${
              humanAudioUrl
                ? 'bg-green-100 text-green-800 border border-green-300'
                : ytSource
                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                : 'bg-amber-100 text-amber-800'
            }\`}
          >
            {humanAudioUrl
              ? '🎙️ Real Human Audio Ready on Device'
              : ytSource
              ? \`🎬 Curated YouTube Talk: \${ytSource.speaker}\`
              : '⚠️ Synthetic TTS Fallback'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-xs font-semibold text-slate-600">Speed:</label>
          {[0.85, 0.95, 1.0, 1.1].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => setSpeechRate(rate)}
              className={\`px-2 py-1 text-xs rounded-lg font-mono font-semibold border cursor-pointer \${
                speechRate === rate
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-700 border-slate-200'
              }\`}
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
              className="text-xs font-semibold text-primary-800 bg-primary-50 border border-primary-200 px-2.5 py-1 rounded-lg cursor-pointer max-w-[240px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.sourceAttribution || p.prompt.slice(0, 35)}
                  </option>
                );
              })}
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
`,

  // =========================================================================
  // 5. DICTOGLOSS BLOCK: Unseen-First Sorting + Completion Marking
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

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
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
        if (res.ok) {
          manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
        }
      } catch {
        // Offline or manifest empty
      }

      const hydrated = all.map((q) => {
        if (q.youtubeSource?.clipKey && manifest[q.youtubeSource.clipKey] && !q.audioUrl) {
          const cached = manifest[q.youtubeSource.clipKey];
          return {
            ...q,
            audioUrl: normalizeAudioUrl(cached.audioUrl),
            sourceAudioText: cached.text || q.sourceAudioText,
          };
        }
        return {
          ...q,
          audioUrl: q.audioUrl ? normalizeAudioUrl(q.audioUrl) : q.audioUrl,
        };
      });

      const items = hydrated.filter(
        (q) => Boolean(q.audioUrl) || q.tags.includes('dictogloss') || q.skill === 'listening'
      );

      // Sort UNSEEN passages first, then by human audio availability
      items.sort((a, b) => {
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0);
      });

      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
      } else {
        const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
        if (firstUnseen >= 0) setSelectedIdx(firstUnseen);
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
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.';

  const handlePlayPassage = useCallback(() => {
    if (humanAudioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setIsPlaying(true);
      return;
    }
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
  }, [humanAudioUrl, sourcePassage]);

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

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-accent-700">
            Dictogloss Working-Memory Protocol {humanAudioUrl ? '(🎙️ Real Human Audio)' : '(TTS Fallback)'}
          </span>
          <p className="text-xs text-slate-500 mt-0.5">
            Phase 1: Listen & take compressed 2-4 word fragment notes. Phase 2: Reconstruct full meaning from memory.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg cursor-pointer max-w-[220px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.sourceAttribution || p.prompt.slice(0, 32)}
                  </option>
                );
              })}
            </select>
          )}
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
            2. Reconstruct Meaning
          </button>
        </div>
      </div>

      {humanAudioUrl && (
        <audio
          ref={audioRef}
          src={humanAudioUrl}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setPlayCount((c) => c + 1);
          }}
          className="hidden"
        />
      )}

      {phase === 'listen' ? (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-accent-800">
              Audio Listens Used: {playCount} / 2 (Transcript hidden to train working memory)
            </span>
            <button
              type="button"
              onClick={handlePlayPassage}
              disabled={isPlaying}
              className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer"
            >
              {isPlaying
                ? 'Playing Lecture Audio...'
                : playCount === 0
                ? '▶ Play Passage (1st Listen: Comprehension)'
                : '▶ Play Again (2nd Listen: Fragment Note-Taking)'}
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
              <span>Compress spoken clauses into 2–4 word fragments</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                setPhase('reconstruct');
              }}
              className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Lock Audio & Start Reconstruction →
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
            onChange={(e) => {
              const val = e.target.value;
              const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
              updateResponse(block.id, {
                textOrTranscript: val,
                promptSnapshot: sourcePassage,
                questionId: currentItem?.id,
              });
              if (wc >= 25 && currentItem && !completedIds.has(currentItem.id)) {
                void markQuestionCompleted(currentItem.id);
                setCompletedIds((prev) => new Set(prev).add(currentItem.id));
              }
            }}
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
  // 6. MOCK TEST BLOCK: Unseen-First Selection + Completion Marking
  // =========================================================================
  'src/components/exam/blocks/MockTestBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  getAdaptiveQuestions,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import { InteractiveReadingBlock } from './InteractiveReadingBlock';
import { VocabWritingBlock } from './VocabWritingBlock';
import type { BlockConfig, QuestionBankItem, DETQuestionType, DETSkill } from '../../../types';

const QUESTION_TYPE_LABELS: { value: DETQuestionType | 'adaptive'; label: string }[] = [
  { value: 'interactive-writing', label: '📝 Interactive Writing (Argumentative Essay)' },
  { value: 'read-and-complete', label: '✍️ Read & Complete (1-Letter-Per-Box Cloze)' },
  { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
  { value: 'write-about-photo', label: '🧩 Collocation Chunk Writing' },
  { value: 'adaptive', label: '🎯 Adaptive (Targets Weakest Skill)' },
  { value: 'listen-and-type', label: '🎧 Listen & Type / Dictogloss' },
  { value: 'read-aloud', label: '🗣️ Read Aloud / Shadowing' },
  { value: 'interactive-speaking', label: '🎙️ Interactive Speaking' },
  { value: 'speaking-sample', label: '🎤 Speaking Sample' },
];

export function MockTestBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const activeRun = useSessionStore((s) => s.activeRun);

  const [selectedType, setSelectedType] = useState<DETQuestionType | 'adaptive'>(
    block.preferredQuestionType ??
      (activeRun?.preferredQuestionType === 'all'
        ? 'interactive-writing'
        : activeRun?.preferredQuestionType) ??
      'interactive-writing'
  );
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [currentIndex, setCurrentIndex] = useState(0);
  const [weakestSkill, setWeakestSkill] = useState<DETSkill | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  useEffect(() => {
    getAdaptiveQuestions({
      questionType: selectedType,
      limit: 25,
    }).then(({ selected, weakestSkill: ws, completedIds: doneSet }) => {
      setQuestions(selected);
      setWeakestSkill(ws);
      setCompletedIds(new Set(doneSet));

      if (selected.length > 0) {
        let idx = 0;
        if (block.questionSetId) {
          const pinned = selected.findIndex((q) => q.id === block.questionSetId);
          if (pinned >= 0) idx = pinned;
        } else {
          const firstUnseen = selected.findIndex((q) => !doneSet.has(q.id));
          if (firstUnseen >= 0) idx = firstUnseen;
        }
        setCurrentIndex(idx);
      }
    });
  }, [selectedType, block.questionSetId]);

  const activeQuestion = questions[currentIndex] ?? null;
  const activePrompt =
    activeQuestion?.prompt ||
    block.instructions ||
    'Complete the DET-style task below under strict exam conditions.';

  const handleSelectQuestionIndex = (idx: number) => {
    const q = questions[idx];
    if (!q) return;
    setCurrentIndex(idx);
    updateResponse(block.id, {
      questionId: q.id,
      questionType: q.type,
      promptSnapshot: q.prompt,
    });
  };

  const handleNextUnseen = () => {
    const nextUnseen = questions.findIndex(
      (q, i) => i !== currentIndex && !completedIds.has(q.id)
    );
    if (nextUnseen >= 0) {
      handleSelectQuestionIndex(nextUnseen);
    } else if (questions.length > 1) {
      handleSelectQuestionIndex((currentIndex + 1) % questions.length);
    }
  };

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const wc = val.trim() ? val.trim().split(/\\s+/).length : 0;
      updateResponse(block.id, {
        textOrTranscript: val,
        promptSnapshot: activePrompt,
        questionId: activeQuestion?.id,
        questionType: activeQuestion?.type ?? selectedType,
      });
      if (wc >= 40 && activeQuestion && !completedIds.has(activeQuestion.id)) {
        void markQuestionCompleted(activeQuestion.id);
        setCompletedIds((prev) => new Set(prev).add(activeQuestion.id));
      }
    },
    [
      activePrompt,
      activeQuestion,
      block.id,
      completedIds,
      selectedType,
      updateResponse,
    ]
  );

  const isReadingInteractive =
    selectedType === 'interactive-reading' ||
    selectedType === 'read-and-complete' ||
    activeQuestion?.type === 'interactive-reading' ||
    activeQuestion?.type === 'read-and-complete';

  const isCollocationWriting =
    selectedType === 'write-about-photo' ||
    (activeQuestion?.targetChunks && activeQuestion.targetChunks.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">DET Task Type:</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as DETQuestionType | 'adaptive')}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
          >
            {QUESTION_TYPE_LABELS.map((qt) => (
              <option key={qt.value} value={qt.value}>
                {qt.label}
              </option>
            ))}
          </select>
          {weakestSkill && (
            <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
              Adaptive Focus: {weakestSkill}
            </span>
          )}
        </div>

        {!isReadingInteractive && !isCollocationWriting && questions.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={currentIndex}
              onChange={(e) => handleSelectQuestionIndex(Number(e.target.value))}
              className="text-xs font-semibold text-slate-800 border border-slate-300 rounded-lg px-2.5 py-1 bg-slate-50 max-w-xs"
            >
              {questions.map((q, idx) => {
                const isDone = completedIds.has(q.id);
                return (
                  <option key={q.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {q.dayNumber ? \`Day \${q.dayNumber}: \` : \`#\${idx + 1}: \`}
                    {q.prompt.slice(0, 44)}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={handleNextUnseen}
              className="px-3 py-1 text-xs font-bold bg-slate-900 text-white rounded-lg hover:bg-slate-800 cursor-pointer"
            >
              Next Unseen →
            </button>
          </div>
        )}
      </div>

      {isReadingInteractive ? (
        <InteractiveReadingBlock
          block={block}
          forcedMode={
            selectedType === 'read-and-complete' || activeQuestion?.type === 'read-and-complete'
              ? 'read-and-complete'
              : 'interactive-reading'
          }
        />
      ) : isCollocationWriting ? (
        <VocabWritingBlock block={block} />
      ) : (
        <>
          <div className="bg-white border-2 border-slate-200 rounded-xl p-5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2.5 py-0.5 rounded uppercase tracking-wide">
                {activeQuestion?.type ?? 'interactive-writing'}
                {activeQuestion?.dayNumber ? \` • Plan Day \${activeQuestion.dayNumber}\` : ''}
              </span>
              {activeQuestion?.sourceAttribution && (
                <span className="text-xs text-slate-500 font-medium">
                  {activeQuestion.sourceAttribution}
                </span>
              )}
            </div>
            <p className="text-base text-slate-800 leading-relaxed font-medium">{activePrompt}</p>
            {activeQuestion?.sampleAnswer && (
              <details className="pt-1 text-xs text-slate-600">
                <summary className="cursor-pointer font-bold text-primary-700 hover:underline">
                  Show Reference 150-Band Sample Argument
                </summary>
                <p className="mt-1.5 p-3 bg-slate-50 rounded-lg border border-slate-200 italic">
                  {activeQuestion.sampleAnswer}
                </p>
              </details>
            )}
          </div>

          <textarea
            value={text}
            onChange={handleChange}
            placeholder="Write your full structured DET essay response here..."
            className="w-full min-h-[260px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed"
            spellCheck
            autoFocus
          />

          <div className="flex justify-between text-xs text-slate-500">
            <span>Aim for 120–180 words, clear thesis & counter-argument, and C1/C2 transitions</span>
            <span className="font-mono font-semibold text-slate-700">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 7. SESSION STORE: Auto-Marks Completed Questions & Daily Study Plan Slots
  // =========================================================================
  'src/stores/sessionStore.ts': `import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionTemplate,
  SessionRun,
  BlockConfig,
  BlockResponse,
  DETQuestionType,
} from '../types';
import { db } from '../db';
import { markQuestionCompleted } from '../utils/adaptive';

export interface StartSessionOptions {
  selectedBlockIds?: string[];
  customDurations?: Record<string, number>;
  instantFeedback?: boolean;
  communicativePressure?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  planDay?: number;
  planSlotIndex?: number; // 1, 2, or 3
}

interface SessionState {
  activeRun: SessionRun | null;
  currentBlockIndex: number;
  blockElapsedSec: number;
  overallElapsedSec: number;
  isRunning: boolean;
  isPaused: boolean;
  transitionCountdown: number | null;
  draftResponses: Record<string, BlockResponse>;
  selectedTemplateId: string | null;
  lastSavedAt: string | null;
}

interface SessionActions {
  startSession: (template: SessionTemplate, options?: StartSessionOptions) => Promise<void>;
  resumeSession: (run: SessionRun) => void;
  tick: () => void;
  advanceBlock: () => void;
  jumpToBlock: (index: number) => void;
  completeBlock: () => void;
  updateResponse: (blockId: string, patch: Partial<BlockResponse>) => void;
  pauseSession: () => void;
  resumeRunning: () => void;
  completeSession: () => Promise<void>;
  persistToDb: () => Promise<void>;
  abandonSession: () => Promise<void>;
  clearActiveRun: () => void;
  setSelectedTemplateId: (id: string | null) => void;
}

const TRANSITION_SEC = 3;

function emptyResponse(block: BlockConfig): BlockResponse {
  return {
    blockId: block.id,
    type: block.type,
    questionType: block.preferredQuestionType ?? block.type,
    questionId: block.questionSetId,
    attemptCount: 1,
    isComplete: false,
    timeSpentSec: 0,
  };
}

function buildResponses(blocks: BlockConfig[]): Record<string, BlockResponse> {
  return Object.fromEntries(blocks.map((b) => [b.id, emptyResponse(b)]));
}

function inferSlotFromTemplateId(templateId?: string | null): number | undefined {
  if (!templateId) return undefined;
  if (templateId === 'tpl-daily-session-1-reading-vocab') return 1;
  if (templateId === 'tpl-daily-session-2-listening-shadowing') return 2;
  if (templateId === 'tpl-daily-session-3-production-mock') return 3;
  return undefined;
}

export const useSessionStore = create<SessionState & SessionActions>()(
  (set, get) => ({
    activeRun: null,
    currentBlockIndex: 0,
    blockElapsedSec: 0,
    overallElapsedSec: 0,
    isRunning: false,
    isPaused: false,
    transitionCountdown: null,
    draftResponses: {},
    selectedTemplateId: null,
    lastSavedAt: null,

    setSelectedTemplateId: (id) => set({ selectedTemplateId: id }),

    clearActiveRun: () =>
      set({
        activeRun: null,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: {},
      }),

    startSession: async (template, options) => {
      const now = new Date().toISOString();
      const settings = await db.settings.get('app-settings');
      const currentPlanDay = options?.planDay ?? settings?.currentPlanDay ?? 1;
      const inferredSlot = options?.planSlotIndex ?? inferSlotFromTemplateId(template.id);

      const filteredBlocks = template.blocks
        .filter((b) =>
          options?.selectedBlockIds ? options.selectedBlockIds.includes(b.id) : true
        )
        .map((b) => ({
          ...b,
          durationSec: options?.customDurations?.[b.id] ?? b.durationSec,
        }));

      const blockConfigs =
        filteredBlocks.length > 0 ? filteredBlocks : template.blocks.map((b) => ({ ...b }));
      const responses = buildResponses(blockConfigs);

      const run: SessionRun = {
        id: uuidv4(),
        templateId: template.id,
        templateName: template.name,
        blockConfigs,
        responses,
        currentBlockIndex: 0,
        status: 'in-progress',
        overallElapsedSec: 0,
        instantFeedback: options?.instantFeedback ?? true,
        communicativePressure: options?.communicativePressure ?? false,
        preferredQuestionType: options?.preferredQuestionType ?? 'adaptive',
        planDay: currentPlanDay,
        planSlotIndex: inferredSlot,
        startedAt: now,
        endedAt: null,
      };

      await db.sessionRuns.put(run);
      set({
        activeRun: run,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: responses,
        lastSavedAt: now,
      });
    },

    resumeSession: (run) => {
      const activeBlock = run.blockConfigs[run.currentBlockIndex];
      const savedBlockTime = activeBlock
        ? (run.responses[activeBlock.id]?.timeSpentSec ?? 0)
        : 0;
      set({
        activeRun: run,
        currentBlockIndex: run.currentBlockIndex,
        blockElapsedSec: savedBlockTime,
        overallElapsedSec: run.overallElapsedSec,
        isRunning: true,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: { ...run.responses },
        lastSavedAt: new Date().toISOString(),
      });
    },

    tick: () => {
      const state = get();
      if (!state.isRunning || state.isPaused || !state.activeRun) return;

      if (state.transitionCountdown !== null) {
        if (state.transitionCountdown <= 1) {
          set({ transitionCountdown: null, blockElapsedSec: 0 });
        } else {
          set({ transitionCountdown: state.transitionCountdown - 1 });
        }
        return;
      }

      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      if (!block) return;

      if (state.blockElapsedSec >= block.durationSec && !block.autoAdvance) {
        return;
      }

      const newBlockElapsed = state.blockElapsedSec + 1;
      const newOverall = state.overallElapsedSec + 1;
      const isLastBlock =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;

      const updatedResponses = {
        ...state.draftResponses,
        [block.id]: {
          ...state.draftResponses[block.id],
          timeSpentSec: newBlockElapsed,
        },
      };

      if (newBlockElapsed >= block.durationSec) {
        updatedResponses[block.id] = {
          ...updatedResponses[block.id],
          isComplete: true,
          timeSpentSec: block.durationSec,
        };

        const qId = updatedResponses[block.id]?.questionId;
        if (qId) void markQuestionCompleted(qId);

        if (!block.autoAdvance) {
          set({
            blockElapsedSec: block.durationSec,
            overallElapsedSec: newOverall,
            draftResponses: updatedResponses,
          });
          void get().persistToDb();
          return;
        }

        if (isLastBlock) {
          set({
            blockElapsedSec: block.durationSec,
            overallElapsedSec: newOverall,
            draftResponses: updatedResponses,
            isRunning: false,
          });
          void get().completeSession();
          return;
        }

        set({
          currentBlockIndex: state.currentBlockIndex + 1,
          blockElapsedSec: 0,
          overallElapsedSec: newOverall,
          draftResponses: updatedResponses,
          transitionCountdown: TRANSITION_SEC,
        });
        void get().persistToDb();
        return;
      }

      set({
        blockElapsedSec: newBlockElapsed,
        overallElapsedSec: newOverall,
        draftResponses: updatedResponses,
      });

      if (newOverall % 5 === 0) void get().persistToDb();
    },

    advanceBlock: () => {
      const state = get();
      if (!state.activeRun) return;
      const isLast =
        state.currentBlockIndex >= state.activeRun.blockConfigs.length - 1;
      const block = state.activeRun.blockConfigs[state.currentBlockIndex];

      if (block) {
        const currentResp = state.draftResponses[block.id];
        if (
          currentResp?.questionId &&
          Boolean(
            currentResp.textOrTranscript?.trim() ||
              currentResp.audioBlobRef ||
              currentResp.aiOverallScore
          )
        ) {
          void markQuestionCompleted(currentResp.questionId);
        }

        set({
          draftResponses: {
            ...state.draftResponses,
            [block.id]: {
              ...state.draftResponses[block.id],
              isComplete: true,
              timeSpentSec: state.blockElapsedSec,
            },
          },
        });
      }

      if (isLast) {
        void get().completeSession();
        return;
      }

      set({
        currentBlockIndex: state.currentBlockIndex + 1,
        blockElapsedSec: 0,
        transitionCountdown: TRANSITION_SEC,
      });
      void get().persistToDb();
    },

    jumpToBlock: (index) => {
      const state = get();
      if (!state.activeRun) return;
      if (index < 0 || index >= state.activeRun.blockConfigs.length) return;
      const targetBlock = state.activeRun.blockConfigs[index];
      const priorSpent = state.draftResponses[targetBlock.id]?.timeSpentSec ?? 0;
      set({
        currentBlockIndex: index,
        blockElapsedSec: Math.min(priorSpent, targetBlock.durationSec - 1),
        transitionCountdown: null,
      });
      void get().persistToDb();
    },

    completeBlock: () => {
      const state = get();
      if (!state.activeRun) return;
      const block = state.activeRun.blockConfigs[state.currentBlockIndex];
      if (!block) return;

      const currentResp = state.draftResponses[block.id];
      if (currentResp?.questionId) {
        void markQuestionCompleted(currentResp.questionId);
      }

      set({
        draftResponses: {
          ...state.draftResponses,
          [block.id]: {
            ...state.draftResponses[block.id],
            isComplete: true,
            timeSpentSec: state.blockElapsedSec,
          },
        },
      });
      void get().persistToDb();
    },

    updateResponse: (blockId, patch) => {
      const existing = get().draftResponses[blockId] ?? {
        blockId,
        isComplete: false,
        timeSpentSec: get().blockElapsedSec,
      };
      set({
        draftResponses: {
          ...get().draftResponses,
          [blockId]: { ...existing, ...patch },
        },
      });
      void get().persistToDb();
    },

    pauseSession: () => set({ isPaused: true }),
    resumeRunning: () => set({ isPaused: false }),

    completeSession: async () => {
      const state = get();
      if (!state.activeRun) return;
      const now = new Date().toISOString();

      // Mark all answered questions in this session as completed
      for (const resp of Object.values(state.draftResponses)) {
        if (
          resp.questionId &&
          Boolean(
            resp.textOrTranscript?.trim() ||
              resp.audioBlobRef ||
              resp.aiOverallScore
          )
        ) {
          await markQuestionCompleted(resp.questionId);
        }
      }

      // Record daily study plan slot completion if applicable
      const planDay = state.activeRun.planDay;
      const slotIdx =
        state.activeRun.planSlotIndex ??
        inferSlotFromTemplateId(state.activeRun.templateId);

      if (planDay && slotIdx) {
        const settings = await db.settings.get('app-settings');
        if (settings) {
          const updatedSlots = {
            ...(settings.completedPlanSlots ?? {}),
            [\`day-\${planDay}-session-\${slotIdx}\`]: now,
          };
          const s1Done = Boolean(updatedSlots[\`day-\${planDay}-session-1\`]);
          const s2Done = Boolean(updatedSlots[\`day-\${planDay}-session-2\`]);
          const s3Done = Boolean(updatedSlots[\`day-\${planDay}-session-3\`]);
          const nextDay =
            s1Done && s2Done && s3Done && settings.currentPlanDay === planDay
              ? Math.min(21, planDay + 1)
              : settings.currentPlanDay ?? 1;

          await db.settings.put({
            ...settings,
            completedPlanSlots: updatedSlots,
            currentPlanDay: nextDay,
          });
        }
      }

      const completed: SessionRun = {
        ...state.activeRun,
        responses: { ...state.draftResponses },
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
        status: 'completed',
        endedAt: now,
        summary: {
          durationSec: state.overallElapsedSec,
        },
      };

      await db.sessionRuns.put(completed);
      set({
        activeRun: completed,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        lastSavedAt: now,
      });
    },

    persistToDb: async () => {
      const state = get();
      if (!state.activeRun) return;
      const now = new Date().toISOString();
      const snapshot: SessionRun = {
        ...state.activeRun,
        responses: state.draftResponses,
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
      };
      await db.sessionRuns.put(snapshot);
      set({ lastSavedAt: now });
    },

    abandonSession: async () => {
      const state = get();
      if (!state.activeRun) return;
      const abandoned: SessionRun = {
        ...state.activeRun,
        responses: { ...state.draftResponses },
        currentBlockIndex: state.currentBlockIndex,
        overallElapsedSec: state.overallElapsedSec,
        status: 'abandoned',
        endedAt: new Date().toISOString(),
      };
      await db.sessionRuns.put(abandoned);
      set({
        activeRun: null,
        currentBlockIndex: 0,
        blockElapsedSec: 0,
        overallElapsedSec: 0,
        isRunning: false,
        isPaused: false,
        transitionCountdown: null,
        draftResponses: {},
      });
    },
  })
);

type S = SessionState;

export const selectCurrentBlock = (s: S): BlockConfig | undefined =>
  s.activeRun?.blockConfigs[s.currentBlockIndex];

export const selectIsLastBlock = (s: S): boolean =>
  !s.activeRun ? false : s.currentBlockIndex >= s.activeRun.blockConfigs.length - 1;

export const selectBlockTimeRemaining = (s: S): number => {
  const block = s.activeRun?.blockConfigs[s.currentBlockIndex];
  if (!block) return 0;
  return Math.max(0, block.durationSec - s.blockElapsedSec);
};

export const selectTotalDuration = (s: S): number =>
  s.activeRun?.blockConfigs.reduce((sum, b) => sum + b.durationSec, 0) ?? 0;

export const selectOverallProgress = (s: S): number => {
  const total = selectTotalDuration(s);
  return total === 0 ? 0 : Math.min(1, s.overallElapsedSec / total);
};

export const selectBlockProgress = (s: S): number => {
  const block = s.activeRun?.blockConfigs[s.currentBlockIndex];
  if (!block || block.durationSec === 0) return 0;
  return Math.min(1, s.blockElapsedSec / block.durationSec);
};
`,
};

const cwd = process.cwd();
for (const [relPath, content] of Object.entries(files)) {
  const targetPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('Phase 2 (Blocks & Dynamic Chunks) Updated:', path.relative(cwd, targetPath));
}
console.log('\nPhase 2 complete! Ready for Phase 3 (21-Day Study Plan Dashboard & Daily 3-Session Tracker).');