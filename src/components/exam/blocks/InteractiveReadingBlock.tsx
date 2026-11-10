import { useState, useEffect, useMemo } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';

const STEP_LABELS = [
  '1. Complete the Sentences',
  '2. Complete the Passage',
  '3. Highlight the Answer #1',
  '4. Highlight the Answer #2',
  '5. Identify the Idea',
  '6. Title the Passage',
];

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
    forcedMode ?? 'interactive-reading'
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

  useEffect(() => {
    if (forcedMode) setMode(forcedMode);
  }, [forcedMode]);

  useEffect(() => {
    db.questionBank.toArray().then((all) => {
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
  };

  const handleSwitchPassage = (nextIndex: number) => {
    setCurrentIdx(nextIndex);
    resetStates();
  };

  // Grade 6-step Interactive Reading and save DET 0-160 score
  const handleGradeInteractiveReading = () => {
    if (!ir || !activeItem) return;
    let earned = 0;
    let totalPossible = ir.blanks.length + 5;
    const wrongDetails: string[] = [];
    const rightDetails: string[] = [];

    for (const b of ir.blanks) {
      if (clozeAnswers[b.id] === b.correctAnswer) {
        earned += 1;
      } else {
        wrongDetails.push(`Blank [${b.id}]: chose "${clozeAnswers[b.id] || 'none'}" (Correct: "${b.correctAnswer}")`);
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
      wrongDetails.length > 0 ? `Mistakes: ${wrongDetails.join(' | ')}` : 'Zero errors across all 6 steps!',
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
        strengths: rightDetails.length > 0 ? rightDetails : ['Completed interactive reading passage'],
        weaknesses: wrongDetails,
        suggestions: [
          'Pay close attention to discourse markers (however, consequently, whereas) when bridging paragraphs.',
        ],
      },
    });
  };

  // Grade Read and Complete (C-Test)
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

    const summaryTranscript = `[Read and Complete — ${rc.sourceName}] Score: ${earned}/${total} (${detScore}/160). ${
      missedWords.length > 0 ? 'Missed: ' + missedWords.join(', ') : 'All words completed accurately!'
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
        strengths: earned >= total - 2 ? ['Strong orthographic & collocation recall'] : ['Completed C-test passage'],
        weaknesses: missedWords,
        suggestions: ['Look at prepositions and grammatical suffixes (-tion, -ive, -ly) following each blank.'],
      },
    });
  };

  // Render Paragraph 1 with embedded dropdowns for Step 0 (Complete the Sentences)
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

  // Render clickable sentences for Steps 2 & 3 (Highlight the Answer)
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
      {/* Top Mode & Passage Selector Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2">
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
            📖 Interactive Reading (6-Step Suite)
          </button>
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
            ✍️ Read and Complete (C-Test Prefix Cloze)
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
            <span className="text-xs font-mono font-bold text-slate-600">
              Passage {currentIdx + 1} / {filteredList.length}
            </span>
            <button
              type="button"
              onClick={() => handleSwitchPassage((currentIdx + 1) % filteredList.length)}
              className="px-2.5 py-1 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Next Passage →
            </button>
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* MODE 1: 6-STEP INTERACTIVE READING                                  */}
      {/* =================================================================== */}
      {mode === 'interactive-reading' && ir && (
        <div className="space-y-4">
          {/* 6-Step Progress Pills */}
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

          {/* Split-Screen DET Reading Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* LEFT PANE: Source Passage */}
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

              {/* Paragraph 1 */}
              {step === 0
                ? renderParagraphWithDropdowns()
                : renderClickableSentences(ir.paragraph1Sentences, step === 2 || step === 3)}

              {/* Bridge Sentence Slot (Revealed from Step 1 onwards) */}
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

              {/* Paragraph 2 (Revealed from Step 1 onwards) */}
              {step >= 1 &&
                renderClickableSentences(ir.paragraph2Sentences, step === 2 || step === 3)}
            </div>

            {/* RIGHT PANE: Active Task Controls */}
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
                    <p className="text-xs text-slate-500">
                      Focus on academic collocations, cohesive transitions, and grammatical precision.
                    </p>
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

              {/* Step Navigation & Grade Button */}
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

      {/* =================================================================== */}
      {/* MODE 2: READ AND COMPLETE (C-TEST PREFIX COMPLETION)                */}
      {/* =================================================================== */}
      {mode === 'read-and-complete' && rc && (
        <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                Read and Complete • Source: {rc.sourceName}
              </span>
              <h3 className="text-base font-bold text-slate-900 mt-1">{rc.title}</h3>
            </div>
            <button
              type="button"
              onClick={handleGradeReadAndComplete}
              className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              ✓ Check Completed Words
            </button>
          </div>

          <p className="text-xs text-slate-500">
            Type the missing letters to complete each unfinished word in the passage below:
          </p>

          <div className="text-base text-slate-800 leading-10 bg-slate-50 p-5 rounded-xl border border-slate-200">
            {rc.passageWithBlanks.split(/(\{\{\d+\}\})/g).map((part, idx) => {
              const match = part.match(/^\{\{(\d+)\}\}$/);
              if (!match) return <span key={idx}>{part}</span>;
              const bId = match[1];
              const blank = rc.blanks.find((b) => b.id === bId);
              if (!blank) return <span key={idx}>{part}</span>;
              const typed = prefixInputs[bId] ?? '';
              const isCorrect =
                submittedCloze && typed.trim().toLowerCase() === blank.missingSuffix.toLowerCase();
              const isWrong =
                submittedCloze && typed.trim().toLowerCase() !== blank.missingSuffix.toLowerCase();

              return (
                <span
                  key={idx}
                  className="inline-flex items-baseline mx-1 bg-white px-2 py-0.5 rounded-lg border border-slate-300 shadow-2xs"
                >
                  <span className="font-bold text-slate-900 font-mono">{blank.prefix}</span>
                  <input
                    type="text"
                    value={typed}
                    onChange={(e) =>
                      setPrefixInputs((prev) => ({ ...prev, [bId]: e.target.value }))
                    }
                    style={{ width: `${Math.max(4, blank.missingSuffix.length + 1)}ch` }}
                    placeholder={'_'.repeat(blank.missingSuffix.length)}
                    className={`font-mono text-sm font-bold border-b-2 focus:outline-none px-0.5 ${
                      isCorrect
                        ? 'border-green-600 text-green-700 bg-green-50'
                        : isWrong
                        ? 'border-red-600 text-red-700 bg-red-50'
                        : 'border-primary-500 text-primary-700'
                    }`}
                  />
                  {isWrong && (
                    <span className="ml-1 text-xs font-mono font-bold text-green-700">
                      ({blank.fullWord})
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
