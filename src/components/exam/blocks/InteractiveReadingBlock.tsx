import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db, ensureDatabaseUpgraded } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type {
  BlockConfig,
  QuestionBankItem,
  ReadAndCompleteBlank,
  ReadAndCompleteData,
  InteractiveReadingData,
} from '../../../types';

const STEP_LABELS = [
  '1. Complete the Sentences',
  '2. Complete the Passage',
  '3. Highlight the Answer #1',
  '4. Highlight the Answer #2',
  '5. Identify the Idea',
  '6. Title the Passage',
];

function computeReadAndCompleteEvaluation(
  rc: ReadAndCompleteData,
  activeItem: QuestionBankItem,
  inputs: Record<string, string>
) {
  let earned = 0;
  const total = rc.blanks.length;
  const missedWords: string[] = [];

  for (const b of rc.blanks) {
    const userSuffix = (inputs[b.id] ?? '').trim().toLowerCase();
    if (userSuffix === b.missingSuffix.toLowerCase()) {
      earned += 1;
    } else {
      missedWords.push(
        `${b.prefix}[${b.missingSuffix}] (you typed: "${b.prefix}${userSuffix || '___'}")`
      );
    }
  }

  const accuracy = earned / Math.max(1, total);
  const detScore = Math.round(65 + accuracy * 95);
  const summaryTranscript = `[Read and Complete — ${rc.title} (${rc.sourceName})] Score: ${earned}/${total} (${Math.round(
    accuracy * 100
  )}%) -> DET Band ${detScore}/160. ${
    missedWords.length > 0
      ? 'Missed words: ' + missedWords.join(', ')
      : 'All boxed words completed with 100% accuracy!'
  }`;

  return {
    earned,
    total,
    detScore,
    missedWords,
    patch: {
      questionId: activeItem.id,
      questionType: 'read-and-complete',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(60, detScore - 5),
        production: Math.max(60, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: {
          literacy: detScore,
          comprehension: detScore,
          conversation: Math.max(60, detScore - 5),
          production: Math.max(60, detScore - 5),
        },
        criteria: {
          lexical_cloze: `${earned} / ${total} boxed words correct (${Math.round(accuracy * 100)}%)`,
          passage: rc.title,
        },
        strengths:
          earned >= total - 1
            ? ['Excellent orthographic & collocation recall under time pressure']
            : [`Completed ${earned} of ${total} word completions accurately`],
        weaknesses: missedWords,
        suggestions: [
          'Pay attention to grammatical suffixes (-tion, -ive, -ly, -ments) and exact letter box counts.',
        ],
      },
    },
  };
}

function computeInteractiveReadingEvaluation(
  ir: InteractiveReadingData,
  activeItem: QuestionBankItem,
  state: {
    clozeAnswers: Record<string, string>;
    selectedGapSentence: string;
    highlighted1: string;
    highlighted2: string;
    selectedIdea: string;
    selectedTitle: string;
  }
) {
  let earned = 0;
  const totalPossible = ir.blanks.length + 5;
  const wrongDetails: string[] = [];
  const rightDetails: string[] = [];

  for (const b of ir.blanks) {
    if (state.clozeAnswers[b.id] === b.correctAnswer) {
      earned += 1;
    } else {
      wrongDetails.push(
        `Blank [${b.id}]: chose "${state.clozeAnswers[b.id] || 'none'}" (Correct: "${b.correctAnswer}")`
      );
    }
  }
  if (earned === ir.blanks.length) {
    rightDetails.push('Perfect lexical precision on Step 1 (Complete the Sentences).');
  }

  if (state.selectedGapSentence === ir.correctPassageGap) {
    earned += 1;
    rightDetails.push('Correctly bridged discourse transition in Step 2 (Complete the Passage).');
  } else {
    wrongDetails.push('Missed discourse transition sentence in Step 2 (Complete the Passage).');
  }

  if (state.highlighted1.trim() === ir.correctHighlight1.trim()) {
    earned += 1;
    rightDetails.push('Pinpointed exact factual evidence in Step 3 (Highlight the Answer #1).');
  } else {
    wrongDetails.push('Inaccurate sentence selection on Step 3 (Highlight the Answer #1).');
  }

  if (state.highlighted2.trim() === ir.correctHighlight2.trim()) {
    earned += 1;
    rightDetails.push('Pinpointed exact factual evidence in Step 4 (Highlight the Answer #2).');
  } else {
    wrongDetails.push('Inaccurate sentence selection on Step 4 (Highlight the Answer #2).');
  }

  if (state.selectedIdea === ir.correctMainIdea) {
    earned += 1;
    rightDetails.push('Identified primary macro-thesis in Step 5 (Identify the Idea).');
  } else {
    wrongDetails.push('Missed main idea synthesis in Step 5 (Identify the Idea).');
  }

  if (state.selectedTitle === ir.correctTitle) {
    earned += 1;
  } else {
    wrongDetails.push('Selected suboptimal academic title in Step 6.');
  }

  const accuracy = earned / Math.max(1, totalPossible);
  const detScore = Math.round(65 + accuracy * 95);

  const summaryTranscript = [
    `[Interactive Reading — ${ir.sourceName}]`,
    `Accuracy: ${earned}/${totalPossible} (${Math.round(accuracy * 100)}%) -> DET Band ${detScore}/160`,
    wrongDetails.length > 0
      ? `Mistakes: ${wrongDetails.join(' | ')}`
      : 'Zero errors across all 6 steps!',
  ].join('\n');

  return {
    earned,
    totalPossible,
    detScore,
    patch: {
      questionId: activeItem.id,
      questionType: 'interactive-reading',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(60, detScore - 5),
        production: Math.max(60, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: {
          literacy: detScore,
          comprehension: detScore,
          conversation: Math.max(60, detScore - 5),
          production: Math.max(60, detScore - 5),
        },
        criteria: {
          reading_accuracy: `${earned} / ${totalPossible} items correct (${Math.round(accuracy * 100)}%)`,
          source: ir.sourceName,
        },
        strengths:
          rightDetails.length > 0 ? rightDetails : ['Completed interactive reading suite'],
        weaknesses: wrongDetails,
        suggestions: [
          'Pay close attention to discourse markers (however, consequently, whereas) when bridging paragraphs.',
        ],
      },
    },
  };
}

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
            aria-label={`${blank.prefix} letter ${i + 1} of ${len}`}
            className={`w-6 h-7 text-center font-mono text-sm font-bold border border-r-0 last:border-r last:rounded-r-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:z-10 transition-colors ${
              isCorrect
                ? 'bg-green-100 border-green-500 text-green-900'
                : isWrong
                ? 'bg-red-50 border-red-400 text-red-800'
                : ch
                ? 'bg-primary-50 border-primary-400 text-primary-900'
                : 'bg-white border-slate-300 text-slate-800'
            }`}
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

  // CRITICAL FIX: Auto-save & auto-grade Read & Complete whenever any letter box changes
  // so that even if the user clicks "Next Block" without clicking "Check Answers",
  // the full evaluation & DET score are already recorded in draftResponses!
  const syncReadAndCompleteToStore = useCallback(
    (nextInputs: Record<string, string>, markDone: boolean) => {
      if (!rc || !activeItem) return;
      const hasAnyTyped = Object.values(nextInputs).some((v) => v.trim().length > 0);
      if (!hasAnyTyped && !markDone) return;

      const evalData = computeReadAndCompleteEvaluation(rc, activeItem, nextInputs);
      updateResponse(block.id, evalData.patch);

      if (markDone || Object.values(nextInputs).filter((v) => v.trim().length > 0).length >= 3) {
        void markQuestionCompleted(activeItem.id);
        setCompletedIds((prev) => new Set(prev).add(activeItem.id));
      }
      return evalData;
    },
    [activeItem, block.id, rc, updateResponse]
  );

  // CRITICAL FIX: Auto-save & auto-grade 6-Step Interactive Reading whenever any step is answered
  useEffect(() => {
    if (mode !== 'interactive-reading' || !ir || !activeItem) return;
    const anyAnswered =
      Object.keys(clozeAnswers).length > 0 ||
      Boolean(selectedGapSentence) ||
      Boolean(highlighted1) ||
      Boolean(highlighted2) ||
      Boolean(selectedIdea) ||
      Boolean(selectedTitle);

    if (!anyAnswered) return;

    const evalData = computeInteractiveReadingEvaluation(ir, activeItem, {
      clozeAnswers,
      selectedGapSentence,
      highlighted1,
      highlighted2,
      selectedIdea,
      selectedTitle,
    });
    updateResponse(block.id, evalData.patch);
  }, [
    mode,
    ir,
    activeItem,
    clozeAnswers,
    selectedGapSentence,
    highlighted1,
    highlighted2,
    selectedIdea,
    selectedTitle,
    block.id,
    updateResponse,
  ]);

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
    const evalData = computeInteractiveReadingEvaluation(ir, activeItem, {
      clozeAnswers,
      selectedGapSentence,
      highlighted1,
      highlighted2,
      selectedIdea,
      selectedTitle,
    });
    setSubmittedReading(true);
    void markQuestionCompleted(activeItem.id);
    setCompletedIds((prev) => new Set(prev).add(activeItem.id));
    updateResponse(block.id, evalData.patch);
  };

  const handleGradeReadAndComplete = () => {
    if (!rc || !activeItem) return;
    const evalData = syncReadAndCompleteToStore(prefixInputs, true);
    setSubmittedCloze(true);
    if (evalData) {
      setLastClozeScore({
        earned: evalData.earned,
        total: evalData.total,
        detScore: evalData.detScore,
      });
    }
  };

  const renderParagraphWithDropdowns = () => {
    if (!ir) return null;
    const parts = ir.paragraph1WithBlanks.split(/(\{\{\d+\}\})/g);
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-8">
        {parts.map((part, i) => {
          const match = part.match(/^\{\{(\d+)\}\}$/);
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
                className={`px-2.5 py-1 text-sm font-bold rounded-lg border-2 transition-colors cursor-pointer ${
                  isCorrect
                    ? 'bg-green-100 border-green-500 text-green-900'
                    : isWrong
                    ? 'bg-red-100 border-red-500 text-red-900'
                    : val
                    ? 'bg-primary-50 border-primary-500 text-primary-900'
                    : 'bg-amber-50 border-amber-300 text-slate-700'
                }`}
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
              className={`inline transition-colors rounded px-1 py-0.5 ${
                isHighlightStep
                  ? isSelected
                    ? 'bg-amber-200 text-slate-900 font-semibold ring-2 ring-amber-400 cursor-pointer'
                    : 'hover:bg-primary-100 cursor-pointer'
                  : ''
              }`}
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
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
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
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
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
                    {item.dayNumber ? `Day ${item.dayNumber}: ` : `#${idx + 1}: `}
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
            Each small box represents <strong>one missing letter</strong>. Your answers are <strong>auto-saved & auto-scored in real time</strong> for your final session evaluation:
          </p>

          <div className="text-base text-slate-800 leading-10 bg-slate-50 p-6 rounded-xl border border-slate-200">
            {rc.passageWithBlanks.split(/(\{\{\d+\}\})/g).map((part, idx) => {
              const match = part.match(/^\{\{(\d+)\}\}$/);
              if (!match) return <span key={idx}>{part}</span>;
              const bId = match[1];
              const blank = rc.blanks.find((b) => b.id === bId);
              if (!blank) return <span key={idx}>{part}</span>;

              return (
                <SegmentedWordBlank
                  key={`${activeItem?.id}-${bId}`}
                  blank={blank}
                  value={prefixInputs[bId] ?? ''}
                  submitted={submittedCloze}
                  onChange={(newVal) => {
                    const next = { ...prefixInputs, [bId]: newVal };
                    setPrefixInputs(next);
                    syncReadAndCompleteToStore(next, false);
                  }}
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
                className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer ${
                  step === idx
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
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
                  className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    selectedGapSentence
                      ? submittedReading
                        ? selectedGapSentence === ir.correctPassageGap
                          ? 'bg-green-50 border-green-400 text-green-900'
                          : 'bg-red-50 border-red-400 text-red-900'
                        : 'bg-primary-50 border-primary-400 text-slate-900'
                      : 'bg-amber-50/70 border-dashed border-amber-400 text-amber-800 italic'
                  }`}
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
                            className={`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer ${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }`}
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
                            className={`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer ${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }`}
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
                            className={`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer ${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }`}
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
