// fix-phase2-ui-components.mjs
// Run from project root: node fix-phase2-ui-components.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. INTERACTIVE READING BLOCK: Segmented 1-Letter-Per-Box Read & Complete
  // =========================================================================
  'src/components/exam/blocks/InteractiveReadingBlock.tsx': `import { useState, useEffect, useMemo, useRef, type KeyboardEvent, type ChangeEvent } from 'react';
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
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
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
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
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
            {rc.passageWithBlanks.split(/(\\{\\{\\d+\\}\\})/g).map((part, idx) => {
              const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
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
`,

  // =========================================================================
  // 2. SHADOWING BLOCK: Auto-Download Curated YouTube Clips on Demand
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

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
  const [hideTranscript, setHideTranscript] = useState(false);
  const [downloadingYt, setDownloadingYt] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  const loadShadowingPassages = useCallback(async () => {
    const all = await db.questionBank.toArray();
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
          audioUrl: cached.audioUrl,
          sourceAudioText: cached.text || q.sourceAudioText,
          prompt: cached.text || q.prompt,
        };
        await db.questionBank.put(upgraded);
        updatedItems.push(upgraded);
      } else {
        updatedItems.push(q);
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
    setPassages(shadowItems.length > 0 ? shadowItems : updatedItems);
  }, []);

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
  const humanAudioUrl = currentItem?.audioUrl?.trim() || '';
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
        audioUrl: data.audioUrl,
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

        <div className="flex items-center gap-1.5">
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
            <button
              type="button"
              onClick={() => {
                stopNativeAudio();
                setSelectedIdx((i) => (i + 1) % passages.length);
              }}
              className="text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 px-3 py-1 rounded-lg cursor-pointer"
            >
              Next Clip ({selectedIdx + 1}/{passages.length}) →
            </button>
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
  // 3. DICTOGLOSS BLOCK: Syncs with Curated YouTube Manifest + Human Audio
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';

const BACKEND_BASE = 'http://127.0.0.1:8000';

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
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
      const all = await db.questionBank.toArray();
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
            audioUrl: cached.audioUrl,
            sourceAudioText: cached.text || q.sourceAudioText,
          };
        }
        return q;
      });

      const items = hydrated.filter(
        (q) => Boolean(q.audioUrl) || q.tags.includes('dictogloss') || q.skill === 'listening'
      );
      items.sort((a, b) => (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0));
      setPassages(items.length > 0 ? items : hydrated);
    };
    void loadDictoglossItems();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = currentItem?.audioUrl?.trim() || '';
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
        <div className="flex items-center gap-2">
          {passages.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setPlayCount(0);
                setSelectedIdx((i) => (i + 1) % passages.length);
              }}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg cursor-pointer"
            >
              Switch Audio ({selectedIdx + 1}/{passages.length})
            </button>
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
  // 4. MOCK TEST BLOCK: Route Read & Complete and Interactive Reading
  // =========================================================================
  'src/components/exam/blocks/MockTestBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import { InteractiveReadingBlock } from './InteractiveReadingBlock';
import type { BlockConfig, QuestionBankItem, DETQuestionType, DETSkill } from '../../../types';

const QUESTION_TYPE_LABELS: { value: DETQuestionType | 'adaptive'; label: string }[] = [
  { value: 'adaptive', label: '🎯 Adaptive (Targets Weakest Skill)' },
  { value: 'read-and-complete', label: '✍️ Read & Complete (1-Letter-Per-Box Cloze)' },
  { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
  { value: 'interactive-writing', label: '📝 Interactive Writing' },
  { value: 'write-about-photo', label: '🧩 Collocation Chunk Writing' },
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
        ? 'read-and-complete'
        : activeRun?.preferredQuestionType) ??
      'read-and-complete'
  );
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [weakestSkill, setWeakestSkill] = useState<DETSkill | null>(null);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\\s+/).length : 0;

  useEffect(() => {
    getAdaptiveQuestions({
      questionType: selectedType,
      limit: 20,
    }).then(({ selected, weakestSkill: ws }) => {
      setQuestions(selected);
      setWeakestSkill(ws);
      setCurrentIndex(0);
    });
  }, [selectedType]);

  const activeQuestion = questions[currentIndex] ?? null;
  const activePrompt =
    activeQuestion?.prompt ||
    block.instructions ||
    'Complete the DET-style task below under strict exam conditions.';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, {
        textOrTranscript: e.target.value,
        promptSnapshot: activePrompt,
        questionId: activeQuestion?.id,
        questionType: activeQuestion?.type ?? selectedType,
      });
    },
    [activePrompt, activeQuestion?.id, activeQuestion?.type, block.id, selectedType, updateResponse]
  );

  const isReadingInteractive =
    selectedType === 'interactive-reading' ||
    selectedType === 'read-and-complete' ||
    activeQuestion?.type === 'interactive-reading' ||
    activeQuestion?.type === 'read-and-complete';

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

        {!isReadingInteractive && questions.length > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCurrentIndex((i) => (i - 1 + questions.length) % questions.length)}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
            >
              ← Prev
            </button>
            <span className="text-xs text-slate-500 font-mono">
              {currentIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              onClick={() => setCurrentIndex((i) => (i + 1) % questions.length)}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
            >
              Next Prompt →
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
      ) : (
        <>
          <div className="bg-white border-2 border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-primary-700 bg-primary-50 px-2.5 py-0.5 rounded uppercase tracking-wide">
                {activeQuestion?.type ?? 'mock-test'} • {activeQuestion?.difficulty ?? 'hard'}
              </span>
              {activeQuestion?.sourceAttribution && (
                <span className="text-xs text-slate-500 font-medium">
                  Source: {activeQuestion.sourceAttribution}
                </span>
              )}
            </div>
            <p className="text-base text-slate-800 leading-relaxed font-medium">{activePrompt}</p>
          </div>

          <textarea
            value={text}
            onChange={handleChange}
            placeholder="Type your full DET response here..."
            className="w-full min-h-[260px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed"
            spellCheck
            autoFocus
          />

          <div className="flex justify-between text-xs text-slate-500">
            <span>Aim for structured paragraphs, varied subordination, and precise vocabulary</span>
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
  // 5. BLOCK INPUT ROUTER: Route 'interactive-reading', 'shadowing', 'dictogloss'
  // =========================================================================
  'src/components/exam/BlockInputRouter.tsx': `import type { BlockConfig } from '../../types';
import { BrainDumpBlock } from './blocks/BrainDumpBlock';
import { VocabWritingBlock } from './blocks/VocabWritingBlock';
import { SpeakingBlock } from './blocks/SpeakingBlock';
import { ShadowingBlock } from './blocks/ShadowingBlock';
import { DictoglossBlock } from './blocks/DictoglossBlock';
import { InteractiveReadingBlock } from './blocks/InteractiveReadingBlock';
import { MockTestBlock } from './blocks/MockTestBlock';
import { CustomBlock } from './blocks/CustomBlock';

interface BlockInputRouterProps {
  block: BlockConfig;
}

export function BlockInputRouter({ block }: BlockInputRouterProps) {
  switch (block.type) {
    case 'interactive-reading':
      return <InteractiveReadingBlock block={block} />;
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
  // 6. PRE-SESSION: Include Read & Complete and Interactive Reading Filters
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
  const [preferredQuestionType, setPreferredQuestionType] =
    useState<DETQuestionType | 'all' | 'adaptive'>('adaptive');

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
  const hasSpeakingBlock = activeBlocks.some(
    (b) => b.type === 'speaking' || b.type === 'shadowing'
  );
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
              <li
                key={i}
                className="text-xs text-slate-800 flex items-start justify-between gap-2 bg-white/80 p-2 rounded-lg border border-amber-100"
              >
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
                  <span className="text-xs font-mono text-slate-500">
                    {t.blocks.length} blocks
                  </span>
                </div>
                {t.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                )}
              </div>
            </label>
          ))}
        </div>
      </div>

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
              const durMin = Math.max(
                1,
                Math.round((customDurations[b.id] ?? b.durationSec) / 60)
              );
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
              <p className="text-sm font-semibold text-slate-800">
                Instant Write-Critique-Rewrite Loop
              </p>
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
              <p className="text-sm font-bold text-red-700">
                Strict Communicative Pressure Mode
              </p>
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
              setPreferredQuestionType(
                e.target.value as DETQuestionType | 'all' | 'adaptive'
              )
            }
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-800 mb-2"
          >
            <option value="adaptive">Adaptive + SRS Due First (Recommended)</option>
            <option value="all">All Question Types</option>
            <option value="read-and-complete">✍️ Read & Complete (Letter Boxes) Only</option>
            <option value="interactive-reading">📖 Interactive Reading (6-Step Suite) Only</option>
            <option value="interactive-writing">📝 Interactive Writing Only</option>
            <option value="write-about-photo">🧩 Collocation Chunk Writing Only</option>
            <option value="speaking-sample">🎤 Speaking Sample Only</option>
            <option value="interactive-speaking">🎙️ Interactive Speaking Only</option>
            <option value="read-aloud">🗣️ Read Aloud / Shadowing Only</option>
            <option value="listen-and-type">🎧 Listen & Type / Dictogloss Only</option>
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
  // 7. QUESTION BANK EDITOR: Edit Read & Complete [Bracket] Syntax + YouTube Sync
  // =========================================================================
  'src/components/config/QuestionBankEditor.tsx': `import { useState, useEffect } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { db, ensureDatabaseUpgraded } from '../../db/database';
import type {
  QuestionBankItem,
  DETSkill,
  DETQuestionType,
  ReadAndCompleteData,
  ReadAndCompleteBlank,
} from '../../types';
import { generateId } from '../../utils/helpers';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function readAndCompleteToBracketText(rc?: ReadAndCompleteData): string {
  if (!rc) return '';
  return rc.passageWithBlanks.replace(/\\{\\{(\\d+)\\}\\}/g, (match, id) => {
    const b = rc.blanks.find((item) => item.id === id);
    if (!b) return match;
    return \`\${b.prefix}[\${b.missingSuffix}]\`;
  });
}

function parseBracketTextToReadAndComplete(
  bracketText: string,
  title: string,
  sourceName: string
): ReadAndCompleteData {
  const blanks: ReadAndCompleteBlank[] = [];
  let counter = 0;
  const passageWithBlanks = bracketText.replace(
    /([a-zA-Z]+)\\[([a-zA-Z]+)\\]/g,
    (_fullMatch, prefix: string, suffix: string) => {
      counter += 1;
      const id = String(counter);
      blanks.push({
        id,
        prefix,
        missingSuffix: suffix,
        fullWord: prefix + suffix,
      });
      return \`{{\${id}}}\`;
    }
  );
  return {
    title: title || 'Custom Read and Complete Passage',
    sourceName: sourceName || 'Custom Academic Source',
    passageWithBlanks,
    blanks,
  };
}

function autoBracketPlainParagraph(plainText: string): string {
  const clean = plainText.replace(/([a-zA-Z]+)\\[([a-zA-Z]+)\\]/g, '$1$2');
  const tokens = clean.split(/(\\s+)/);
  let wordCounter = 0;
  let blanksCreated = 0;

  return tokens
    .map((tok) => {
      const match = tok.match(/^([a-zA-Z]{5,})([.,;!?]?)$/);
      if (!match) return tok;
      wordCounter += 1;
      if (wordCounter % 5 === 0 && blanksCreated < 12) {
        const word = match[1];
        const punct = match[2] ?? '';
        const keepLen = Math.max(2, Math.floor(word.length / 2));
        const prefix = word.slice(0, keepLen);
        const suffix = word.slice(keepLen);
        blanksCreated += 1;
        return \`\${prefix}[\${suffix}]\${punct}\`;
      }
      return tok;
    })
    .join('');
}

export function QuestionBankEditor() {
  const questions = useConfigStore((s) => s.questions);
  const saveQuestion = useConfigStore((s) => s.saveQuestion);
  const deleteQuestion = useConfigStore((s) => s.deleteQuestion);

  const [filterSkill, setFilterSkill] = useState<DETSkill | 'all'>('all');
  const [editingQuestion, setEditingQuestion] = useState<QuestionBankItem | null>(null);
  const [chunksInput, setChunksInput] = useState<string>('');
  const [tagsInput, setTagsInput] = useState<string>('');

  const [rcTitle, setRcTitle] = useState('');
  const [rcSource, setRcSource] = useState('');
  const [rcBracketText, setRcBracketText] = useState('');

  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState('');
  const [ytStart, setYtStart] = useState('00:20');
  const [ytEnd, setYtEnd] = useState('01:35');
  const [audioStatus, setAudioStatus] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Ensure DB is upgraded and store is synced when opening Question Bank
  useEffect(() => {
    void ensureDatabaseUpgraded().then(async () => {
      const allInDb = await db.questionBank.toArray();
      if (allInDb.length > questions.length && allInDb[0]) {
        await saveQuestion(allInDb[0]);
      }
    });
  }, [questions.length, saveQuestion]);

  const skills: { value: DETSkill; label: string }[] = [
    { value: 'reading', label: '📖 Reading (Read & Complete / Interactive)' },
    { value: 'writing', label: '✍️ Writing & Chunks' },
    { value: 'speaking', label: '🗣️ Speaking & Shadowing' },
    { value: 'listening', label: '🎧 Listening & Dictogloss' },
  ];

  const questionTypes: { value: DETQuestionType; label: string; skill: DETSkill }[] = [
    { value: 'read-and-complete', label: 'Read and Complete (Prefix Letter Boxes)', skill: 'reading' },
    { value: 'interactive-reading', label: 'Interactive Reading (6-Step Suite)', skill: 'reading' },
    { value: 'read-aloud', label: 'Read Aloud / Arguelles Shadowing', skill: 'speaking' },
    { value: 'listen-and-type', label: 'Listen & Type / Dictogloss', skill: 'listening' },
    { value: 'write-about-photo', label: 'Collocation Chunk Writing', skill: 'writing' },
    { value: 'interactive-writing', label: 'Interactive Writing', skill: 'writing' },
    { value: 'interactive-speaking', label: 'Interactive Speaking', skill: 'speaking' },
    { value: 'speaking-sample', label: 'Speaking Sample', skill: 'speaking' },
  ];

  const filtered =
    filterSkill === 'all' ? questions : questions.filter((q) => q.skill === filterSkill);

  const openEditor = (q: QuestionBankItem) => {
    setEditingQuestion({ ...q });
    setChunksInput((q.targetChunks ?? []).join(', '));
    setTagsInput((q.tags ?? []).join(', '));
    setRcTitle(q.readAndComplete?.title ?? q.prompt ?? '');
    setRcSource(q.readAndComplete?.sourceName ?? q.sourceAttribution ?? 'BBC Science Focus / The Conversation');
    setRcBracketText(readAndCompleteToBracketText(q.readAndComplete));
    setYtUrl(q.youtubeSource?.url ?? '');
    setYtStart(q.youtubeSource?.startTime ?? '00:20');
    setYtEnd(q.youtubeSource?.endTime ?? '01:35');
    setAudioStatus(null);
    setAudioError(null);
  };

  const handleNewReadAndComplete = () => {
    openEditor({
      id: generateId(),
      skill: 'reading',
      type: 'read-and-complete',
      prompt: 'Read and Complete: Custom Academic Passage',
      sourceAttribution: 'BBC Science Focus / The Conversation',
      difficulty: 'hard',
      tags: ['read-and-complete', 'custom'],
      readAndComplete: {
        title: 'Custom Academic Passage',
        sourceName: 'BBC Science Focus',
        passageWithBlanks:
          'Paste any paragraph below and put [brackets] around the second half of words like {{1}} or click Auto-Convert!',
        blanks: [
          { id: '1', prefix: 'neuro', missingSuffix: 'science', fullWord: 'neuroscience' },
        ],
      },
    });
  };

  const handleNewGeneral = () => {
    openEditor({
      id: generateId(),
      skill: filterSkill === 'all' ? 'speaking' : filterSkill,
      type: filterSkill === 'reading' ? 'read-and-complete' : 'read-aloud',
      prompt: '',
      sourceAudioText: '',
      audioUrl: '',
      targetChunks: [],
      difficulty: 'hard',
      tags: ['custom'],
    });
  };

  const handleBatchDownloadCuratedYoutube = async () => {
    const ytQuestions = questions.filter((q) => q.youtubeSource && !q.audioUrl);
    if (ytQuestions.length === 0) {
      setBatchStatus('✓ All curated YouTube shadowing talks are already downloaded to your device!');
      return;
    }
    setBatchDownloading(true);
    let completed = 0;

    for (const q of ytQuestions) {
      if (!q.youtubeSource) continue;
      setBatchStatus(
        \`Downloading & GPU-transcribing (\${completed + 1}/\${ytQuestions.length}): \${q.youtubeSource.speaker}...\`
      );
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: q.youtubeSource.url,
            startTime: q.youtubeSource.startTime,
            endTime: q.youtubeSource.endTime,
            clipKey: q.youtubeSource.clipKey,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { audioUrl: string; text: string };
          await saveQuestion({
            ...q,
            audioUrl: data.audioUrl,
            sourceAudioText: data.text || q.sourceAudioText,
            prompt: data.text || q.prompt,
          });
          completed += 1;
        }
      } catch {
        // Continue to next clip
      }
    }

    setBatchDownloading(false);
    setBatchStatus(
      completed > 0
        ? \`✓ Downloaded & transcribed \${completed} TED/Academic shadowing clips to stt-backend/audio_clips/!\`
        : '⚠️ Could not connect to stt-backend on port 8000 or yt-dlp/ffmpeg is missing.'
    );
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus('Uploading human audio & auto-transcribing with Faster-Whisper...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('auto_transcribe', 'true');

      const res = await fetch(\`\${BACKEND_BASE}/audio/upload\`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Upload failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(\`✓ Human audio attached (\${data.duration}s) & transcribed by Faster-Whisper!\`);
    } catch (err) {
      setAudioError(
        err instanceof Error
          ? err.message
          : 'Could not connect to stt-backend on port 8000.'
      );
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleYoutubeImport = async () => {
    if (!ytUrl.trim() || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus(\`Extracting clip (\${ytStart} - \${ytEnd}) via yt-dlp & transcribing with Whisper...\`);

    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytUrl.trim(),
          startTime: ytStart.trim(),
          endTime: ytEnd.trim(),
          clipKey: editingQuestion.youtubeSource?.clipKey,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'yt-dlp import failed' }));
        throw new Error(errData.detail || 'yt-dlp import failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(\`✓ Imported \${data.duration}s human audio clip & auto-transcribed!\`);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'YouTube import failed');
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleSave = async () => {
    if (!editingQuestion) return;
    const parsedChunks = chunksInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedTags = tagsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let updatedReadAndComplete = editingQuestion.readAndComplete;
    let updatedPrompt = editingQuestion.prompt;

    if (editingQuestion.type === 'read-and-complete') {
      updatedReadAndComplete = parseBracketTextToReadAndComplete(
        rcBracketText,
        rcTitle,
        rcSource
      );
      updatedPrompt = \`Read and Complete: \${rcTitle} (\${rcSource})\`;
    }

    await saveQuestion({
      ...editingQuestion,
      prompt: updatedPrompt,
      sourceAttribution: rcSource || editingQuestion.sourceAttribution,
      readAndComplete: updatedReadAndComplete,
      targetChunks: parsedChunks.length > 0 ? parsedChunks : undefined,
      tags: parsedTags,
    });
    setEditingQuestion(null);
  };

  const previewParsedRc =
    editingQuestion?.type === 'read-and-complete'
      ? parseBracketTextToReadAndComplete(rcBracketText, rcTitle, rcSource)
      : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Question Bank, Reading Builder & YouTube Shadowing Studio
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Create or edit Read & Complete letter-box passages, Interactive Reading suites, or auto-download curated TED talks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewReadAndComplete}
            className="px-3.5 py-2 bg-accent-600 text-white text-xs font-bold rounded-lg hover:bg-accent-700 cursor-pointer"
          >
            + New "Read & Complete" Passage
          </button>
          <button
            type="button"
            onClick={handleNewGeneral}
            className="px-3.5 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            + New Question / Audio Drill
          </button>
        </div>
      </div>

      {!editingQuestion && (
        <div className="bg-slate-900 text-white rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-primary-400">
              🎬 Built-In Curated TED & Academic Shadowing Library (6 Talks Linked)
            </span>
            <p className="text-xs text-slate-300 mt-0.5">
              Includes Lera Boroditsky (TED & Duocon), Mustafa Suleyman (AI), Dr. Lara Boyd (Neuroplasticity), Julian Treasure, and Cambridge Linguistics.
            </p>
            {batchStatus && (
              <p className="text-xs font-semibold text-amber-300 mt-1.5">{batchStatus}</p>
            )}
          </div>
          <button
            type="button"
            disabled={batchDownloading}
            onClick={handleBatchDownloadCuratedYoutube}
            className="px-4 py-2.5 bg-primary-500 hover:bg-primary-600 text-slate-950 font-bold text-xs rounded-xl disabled:opacity-50 cursor-pointer shrink-0"
          >
            {batchDownloading
              ? '⏳ Downloading & Transcribing...'
              : '⬇️ Auto-Download All 6 YouTube Shadowing Clips to Device'}
          </button>
        </div>
      )}

      {!editingQuestion && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilterSkill('all')}
              className={\`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer \${
                filterSkill === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }\`}
            >
              All ({questions.length})
            </button>
            {skills.map((s) => {
              const count = questions.filter((q) => q.skill === s.value).length;
              return (
                <button
                  key={s.value}
                  onClick={() => setFilterSkill(s.value)}
                  className={\`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer \${
                    filterSkill === s.value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }\`}
                >
                  {s.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            {filtered.map((q) => (
              <div
                key={q.id}
                className="bg-white rounded-xl border border-slate-200 p-4 hover:border-primary-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-accent-100 text-accent-700">
                        {q.skill}
                      </span>
                      <span className="text-xs text-slate-600 font-mono font-semibold bg-slate-100 px-2 py-0.5 rounded">
                        {q.type}
                      </span>
                      {q.readAndComplete && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-purple-100 text-purple-800">
                          {q.readAndComplete.blanks.length} Letter-Box Words
                        </span>
                      )}
                      {q.audioUrl && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                          🎙️ Local Human MP3 Ready
                        </span>
                      )}
                      {!q.audioUrl && q.youtubeSource && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                          🎬 YouTube Linked ({q.youtubeSource.speaker})
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-800 font-semibold">{q.prompt}</p>
                    {q.readAndComplete && (
                      <p className="text-xs text-slate-500 font-mono line-clamp-2">
                        {readAndCompleteToBracketText(q.readAndComplete)}
                      </p>
                    )}
                    {q.audioUrl && (
                      <audio controls src={q.audioUrl} className="h-8 w-full max-w-md mt-1" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openEditor(q)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit Question
                    </button>
                    <button
                      onClick={() => deleteQuestion(q.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {editingQuestion && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">
              Edit Question ({editingQuestion.type})
            </h3>
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              ✕ Close Editor
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Skill</label>
              <select
                value={editingQuestion.skill}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, skill: e.target.value as DETSkill })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {skills.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Question Type</label>
              <select
                value={editingQuestion.type}
                onChange={(e) => {
                  const newType = e.target.value as DETQuestionType;
                  const matchedSkill =
                    questionTypes.find((qt) => qt.value === newType)?.skill ??
                    editingQuestion.skill;
                  setEditingQuestion({
                    ...editingQuestion,
                    type: newType,
                    skill: matchedSkill,
                  });
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {questionTypes.map((qt) => (
                  <option key={qt.value} value={qt.value}>
                    {qt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Tags</label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="read-and-complete, bbc, shadowing"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          {editingQuestion.type === 'read-and-complete' && (
            <div className="bg-purple-50/70 border-2 border-purple-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-purple-900">
                    ✍️ Read and Complete Letter-Box Passage Builder
                  </h4>
                  <p className="text-xs text-purple-700 mt-0.5">
                    Put <code>[brackets]</code> around the letters you want hidden as individual boxes: e.g. <code>act[ivity]</code> shows <strong>act</strong> + 5 letter boxes!
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRcBracketText(autoBracketPlainParagraph(rcBracketText))}
                  className="px-3 py-1.5 bg-purple-700 hover:bg-purple-800 text-white text-xs font-bold rounded-lg cursor-pointer"
                >
                  ⚡ Auto-Convert Plain Paragraph into [Bracket] Blanks
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Passage Title:
                  </label>
                  <input
                    type="text"
                    value={rcTitle}
                    onChange={(e) => setRcTitle(e.target.value)}
                    placeholder="e.g., Acoustic Stimulation and Neural Waste Clearance"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Source Attribution (BBC, The Conversation, etc.):
                  </label>
                  <input
                    type="text"
                    value={rcSource}
                    onChange={(e) => setRcSource(e.target.value)}
                    placeholder="e.g., BBC Science Focus — Neurology"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Passage Text with <code>prefix[suffix]</code> Brackets:
                </label>
                <textarea
                  value={rcBracketText}
                  onChange={(e) => setRcBracketText(e.target.value)}
                  rows={6}
                  placeholder="Paste any paragraph here, then either bracket words like neuro[science] or click the Auto-Convert button above..."
                  className="w-full p-3 bg-white border border-purple-300 rounded-lg text-sm font-mono leading-relaxed"
                />
              </div>

              {previewParsedRc && previewParsedRc.blanks.length > 0 && (
                <div className="bg-white p-3.5 rounded-lg border border-purple-200 space-y-2">
                  <p className="text-xs font-bold text-purple-900">
                    Live Preview ({previewParsedRc.blanks.length} Segmented Word Blanks Detected):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {previewParsedRc.blanks.map((b) => (
                      <span
                        key={b.id}
                        className="text-xs font-mono bg-slate-100 border border-slate-300 px-2 py-1 rounded"
                      >
                        <strong>{b.prefix}</strong>
                        <span className="text-purple-700 font-bold">
                          {'[' + '□'.repeat(b.missingSuffix.length) + ']'}
                        </span>{' '}
                        <span className="text-slate-400">({b.missingSuffix.length} boxes)</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {(editingQuestion.skill === 'speaking' || editingQuestion.skill === 'listening') && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-primary-700">
                🎙️ Real Human Audio Source (Upload File or Slice YouTube URL)
              </h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Option 1: Upload Local Human Audio (.mp3, .wav, .m4a)
                  </label>
                  <input
                    type="file"
                    accept="audio/*"
                    disabled={uploadingAudio}
                    onChange={handleFileUpload}
                    className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary-50 file:text-primary-700"
                  />
                </div>

                <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Option 2: Slice YouTube / TED Talk Clip (via yt-dlp)
                  </label>
                  <input
                    type="url"
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={ytStart}
                      onChange={(e) => setYtStart(e.target.value)}
                      placeholder="00:20"
                      className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    />
                    <span className="text-xs text-slate-400">to</span>
                    <input
                      type="text"
                      value={ytEnd}
                      onChange={(e) => setYtEnd(e.target.value)}
                      placeholder="01:35"
                      className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    />
                    <button
                      type="button"
                      disabled={uploadingAudio || !ytUrl.trim()}
                      onClick={handleYoutubeImport}
                      className="flex-1 py-1.5 px-3 bg-accent-600 text-white text-xs font-semibold rounded hover:bg-accent-700 disabled:opacity-50 cursor-pointer"
                    >
                      {uploadingAudio ? 'Processing...' : 'Download & Transcribe'}
                    </button>
                  </div>
                </div>
              </div>

              {editingQuestion.audioUrl && (
                <audio controls src={editingQuestion.audioUrl} className="w-full h-9" />
              )}
              {audioStatus && (
                <div className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg p-2.5">
                  {audioStatus}
                </div>
              )}
              {audioError && (
                <div className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {audioError}
                </div>
              )}
            </div>
          )}

          {editingQuestion.type !== 'read-and-complete' && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Prompt / Verbatim Reference Transcript:
              </label>
              <textarea
                value={editingQuestion.prompt}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    prompt: e.target.value,
                    sourceAudioText: e.target.value,
                  })
                }
                rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          )}

          {editingQuestion.skill === 'writing' && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Target Multi-Word Collocation Chunks (comma-separated):
              </label>
              <input
                type="text"
                value={chunksInput}
                onChange={(e) => setChunksInput(e.target.value)}
                placeholder="rigorous empirical validation, shift the research paradigm"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Save Question
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 8. TEMPLATE EDITOR: Allow Adding Interactive Reading, Shadowing, Dictogloss
  // =========================================================================
  'src/components/config/TemplateEditor.tsx': `import { useEffect } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { ensureDatabaseUpgraded } from '../../db/database';
import type { Block, BlockType } from '../../types';
import { formatTime, generateId } from '../../utils/helpers';

const BLOCK_TYPE_OPTIONS: { value: BlockType; label: string }[] = [
  { value: 'interactive-reading', label: '📖 Interactive Reading & Read/Complete' },
  { value: 'shadowing', label: '🗣️ Arguelles Shadowing (TED / Human Audio)' },
  { value: 'dictogloss', label: '🎧 Dictogloss Working-Memory Reconstruction' },
  { value: 'vocab-writing', label: '🧩 Collocation Chunk Writing (SRS)' },
  { value: 'speaking', label: '🎙️ Timed Verbatim Speaking' },
  { value: 'brain-dump', label: '📝 Brain Dump & Structural Outline' },
  { value: 'mock-test', label: '🎯 Timed Adaptive Mock Test' },
  { value: 'custom', label: '⚙️ Custom Block' },
];

export function TemplateEditor() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const editingTemplate = useConfigStore((s) => s.editingTemplate);
  const setEditingTemplate = useConfigStore((s) => s.setEditingTemplate);
  const createTemplate = useConfigStore((s) => s.createTemplate);
  const saveTemplate = useConfigStore((s) => s.saveTemplate);
  const deleteTemplate = useConfigStore((s) => s.deleteTemplate);
  const duplicateTemplate = useConfigStore((s) => s.duplicateTemplate);

  useEffect(() => {
    void ensureDatabaseUpgraded().then(() => loadTemplates());
  }, [loadTemplates]);

  const handleAddBlock = () => {
    if (!editingTemplate) return;
    const defaultEval = evalPrompts[0]?.id ?? '';
    const newBlock: Block = {
      id: generateId(),
      name: \`Block \${editingTemplate.blocks.length + 1}\`,
      type: 'interactive-reading',
      durationSec: 5 * 60,
      instructions: 'Complete the task below under timed conditions.',
      autoAdvance: false,
      evalPromptId: defaultEval,
    };
    setEditingTemplate({
      ...editingTemplate,
      blocks: [...editingTemplate.blocks, newBlock],
    });
  };

  const handleUpdateBlock = (index: number, patch: Partial<Block>) => {
    if (!editingTemplate) return;
    const nextBlocks = editingTemplate.blocks.map((b, i) =>
      i === index ? { ...b, ...patch } : b
    );
    setEditingTemplate({ ...editingTemplate, blocks: nextBlocks });
  };

  const handleRemoveBlock = (index: number) => {
    if (!editingTemplate) return;
    setEditingTemplate({
      ...editingTemplate,
      blocks: editingTemplate.blocks.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Session Templates</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Build custom practice routines combining Reading, Shadowing, Dictogloss, Writing, and Speaking blocks.
          </p>
        </div>
        <button
          onClick={createTemplate}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 cursor-pointer"
        >
          + New Template
        </button>
      </div>

      {!editingTemplate && (
        <div className="space-y-3">
          {templates.map((t) => {
            const totalDuration = t.blocks.reduce((sum, b) => sum + b.durationSec, 0);
            return (
              <div
                key={t.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:border-primary-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-slate-900">{t.name}</h3>
                    {t.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <span className="text-xs font-mono text-slate-500">
                        Total: {formatTime(totalDuration)}
                      </span>
                      {t.blocks.map((b, idx) => (
                        <span
                          key={b.id}
                          className="text-xs bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full font-medium"
                        >
                          {idx + 1}. {b.name} ({Math.round(b.durationSec / 60)}m)
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setEditingTemplate({ ...t })}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => duplicateTemplate(t.id)}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingTemplate && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Template Name
              </label>
              <input
                type="text"
                value={editingTemplate.name}
                onChange={(e) =>
                  setEditingTemplate({ ...editingTemplate, name: e.target.value })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Description
              </label>
              <input
                type="text"
                value={editingTemplate.description ?? ''}
                onChange={(e) =>
                  setEditingTemplate({
                    ...editingTemplate,
                    description: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Blocks ({editingTemplate.blocks.length})
              </h4>
              <button
                type="button"
                onClick={handleAddBlock}
                className="px-3 py-1.5 bg-accent-600 text-white text-xs font-bold rounded-lg hover:bg-accent-700 cursor-pointer"
              >
                + Add Block
              </button>
            </div>

            {editingTemplate.blocks.map((b, i) => (
              <div
                key={b.id}
                className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3"
              >
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Block Name
                    </label>
                    <input
                      type="text"
                      value={b.name}
                      onChange={(e) => handleUpdateBlock(i, { name: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Block Type
                    </label>
                    <select
                      value={b.type}
                      onChange={(e) =>
                        handleUpdateBlock(i, { type: e.target.value as BlockType })
                      }
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                    >
                      {BLOCK_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Duration (Minutes)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={Math.max(1, Math.round(b.durationSec / 60))}
                      onChange={(e) =>
                        handleUpdateBlock(i, {
                          durationSec: Math.max(1, Number(e.target.value)) * 60,
                        })
                      }
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <input
                    type="text"
                    value={b.instructions}
                    onChange={(e) =>
                      handleUpdateBlock(i, { instructions: e.target.value })
                    }
                    placeholder="Instructions for this block..."
                    className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveBlock(i)}
                    className="px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 rounded cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setEditingTemplate(null)}
              className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveTemplate(editingTemplate)}
              className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Save Template
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
console.log('\nPhase 2 (All 8 UI Components & Routers) applied successfully!');