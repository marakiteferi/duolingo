import { useState, useEffect, useMemo, useRef, type KeyboardEvent, type ChangeEvent } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db, ensureDatabaseUpgraded } from '../../../db/database';
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

  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [mode, setMode] = useState<'interactive-reading' | 'read-and-complete'>(
    forcedMode ?? 'read-and-complete'
  );
  const [currentIdx, setCurrentIdx] = useState(0);

  // Interactive Reading 6-step states
  const [step, setStep] = useState(0);
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [selectedGapSentence, setSelectedGapSentence] = useState<string>('');
  const [highlighted1, setHighlighted1] = useState<string>('');
  const [highlighted2, setHighlighted2] = useState<string>('');
  const [selectedIdea, setSelectedIdea] = useState<string>('');
  const [selectedTitle, setSelectedTitle] = useState<string>('');
  const [submittedReading, setSubmittedReading] = useState(false);

  // Read and Complete (C-Test) states
  const [prefixInputs, setPrefixInputs] = useState<Record<string, string>>({});
  const [submittedCloze, setSubmittedCloze] = useState(false);
  const [lastClozeScore, setLastClozeScore] = useState<{
    earned: number;
    total: number;
    detScore: number;
  } | null>(null);

  useEffect(() => {
    if (forcedMode) setMode(forcedMode);
  }, [forcedMode]);

  useEffect(() => {
    ensureDatabaseUpgraded()
      .then(() => db.questionBank.toArray())
      .then((all) => {
        const readingItems = all.filter(
          (q) =>
            q.skill === 'reading' &&
            (q.type === 'interactive-reading' || q.type === 'read-and-complete')
        );
        setQuestions(readingItems);
      });
  }, []);

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
          `Blank [${b.id}]: chose "${clozeAnswers[b.id] || 'none'}" (Correct: "${b.correctAnswer}")`
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

    const summaryTranscript = [
      `[Interactive Reading — ${ir.sourceName}]`,
      `Accuracy: ${earned}/${totalPossible} (${Math.round(accuracy * 100)}%) -> Estimated DET Band: ${detScore}/160`,
      wrongDetails.length > 0
        ? `Mistakes: ${wrongDetails.join(' | ')}`
        : 'Zero errors across all 6 steps!',
    ].join('\n');

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
          reading_accuracy: `${earned} / ${totalPossible} items correct`,
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
        missedWords.push(`${b.prefix}[${b.missingSuffix}] (you typed: "${b.prefix}${userSuffix}")`);
      }
    }

    const accuracy = earned / Math.max(1, total);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedCloze(true);
    setLastClozeScore({ earned, total, detScore });

    const summaryTranscript = `[Read and Complete — ${rc.sourceName}] Score: ${earned}/${total} (${detScore}/160). ${
      missedWords.length > 0
        ? 'Missed: ' + missedWords.join(', ')
        : 'All words completed accurately!'
    }`;

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
        criteria: { lexical_cloze: `${earned}/${total} correct` },
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

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('read-and-complete');
              setCurrentIdx(0);
              resetStates();
            }}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            ✍️ Read and Complete ({questions.filter((q) => q.type === 'read-and-complete').length} Passages)
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('interactive-reading');
              setCurrentIdx(0);
              resetStates();
            }}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors ${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            📖 Interactive Reading ({questions.filter((q) => q.type === 'interactive-reading').length} Suites)
          </button>
        </div>

        {filteredList.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                handleSwitchPassage((currentIdx - 1 + filteredList.length) % filteredList.length)
              }
              className="px-2.5 py-1 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              ← Prev
            </button>
            <span className="text-xs font-mono font-bold text-slate-700">
              Passage {currentIdx + 1} of {filteredList.length}
            </span>
            <button
              type="button"
              onClick={() => handleSwitchPassage((currentIdx + 1) % filteredList.length)}
              className="px-2.5 py-1 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {mode === 'read-and-complete' && rc && (
        <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                Type the missing letters • Source: {rc.sourceName}
              </span>
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
                  onClick={() => handleSwitchPassage((currentIdx + 1) % filteredList.length)}
                  className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Next Paragraph ({((currentIdx + 1) % filteredList.length) + 1}/{filteredList.length}) →
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Each small box represents <strong>one missing letter</strong>. Typing a letter automatically moves to the next box (use Backspace to go back):
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
                  key={bId}
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
                  <button
                    type="button"
                    onClick={handleGradeInteractiveReading}
                    className="px-5 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer shadow-xs"
                  >
                    ✓ Check All 6 Answers & Score
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
