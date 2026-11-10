// upgrade-reading-and-bank.mjs
// Run from project root: node upgrade-reading-and-bank.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. TYPES: Add InteractiveReadingData, ReadAndCompleteBlank & Question Types
  // =========================================================================
  'src/types/index.ts': `export type DETSkill = 'reading' | 'writing' | 'speaking' | 'listening';

export type DETQuestionType =
  | 'interactive-reading'
  | 'read-and-complete'
  | 'read-aloud'
  | 'write-about-photo'
  | 'listen-and-type'
  | 'interactive-writing'
  | 'interactive-speaking'
  | 'speaking-sample';

export type BlockType =
  | 'interactive-reading'
  | 'brain-dump'
  | 'vocab-writing'
  | 'speaking'
  | 'shadowing'
  | 'dictogloss'
  | 'mock-test'
  | 'custom';

export type STTProvider = 'local-whisper' | 'whisper' | 'web-speech-api';
export type ViewMode = 'config' | 'exam';
export type AppView = ViewMode;
export type SessionStatus = 'in-progress' | 'completed' | 'abandoned';
export type ScoreScale = 'det-0-160' | 'custom';
export type ConfigSection = 'templates' | 'questions' | 'eval-prompts' | 'history' | 'settings';

export interface SRSData {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewDate: string;
}

export interface SRSDefaults {
  startEase: number;
  startIntervalDays: number;
}

export interface Settings {
  id: 'app-settings';
  geminiApiKey: string;
  sttProvider: STTProvider;
  localWhisperUrl?: string;
  localSttEndpoint?: string;
  sttApiKey?: string;
  autoAdvanceDefault: boolean;
  instantFeedbackDefault?: boolean;
  srsDefaults: SRSDefaults;
}

export interface ClozeBlankItem {
  id: string;
  options: string[];
  correctAnswer: string;
}

export interface InteractiveReadingData {
  sourceName: string;
  /** Paragraph 1 containing {{1}}, {{2}}, etc. for "Complete the Sentences" */
  paragraph1WithBlanks: string;
  /** Clean Paragraph 1 split into individual sentences for "Highlight the Answer" */
  paragraph1Sentences: string[];
  blanks: ClozeBlankItem[];
  /** Step 2: Complete the Passage (bridge sentence between P1 and P2) */
  passageGapOptions: string[];
  correctPassageGap: string;
  /** Clean Paragraph 2 split into individual sentences for "Highlight the Answer" */
  paragraph2Sentences: string[];
  /** Step 3: Highlight the Answer #1 */
  highlightQuestion1: string;
  correctHighlight1: string;
  /** Step 4: Highlight the Answer #2 */
  highlightQuestion2: string;
  correctHighlight2: string;
  /** Step 5: Identify the Idea */
  mainIdeaOptions: string[];
  correctMainIdea: string;
  /** Step 6: Title the Passage */
  titleOptions: string[];
  correctTitle: string;
}

export interface ReadAndCompleteBlank {
  id: string;
  prefix: string;
  missingSuffix: string;
  fullWord: string;
}

export interface ReadAndCompleteData {
  sourceName: string;
  title: string;
  /** Passage containing {{1}}, {{2}}, etc. for prefix completion */
  passageWithBlanks: string;
  blanks: ReadAndCompleteBlank[];
}

export interface QuestionBankItem {
  id: string;
  skill: DETSkill;
  type: DETQuestionType;
  prompt: string;
  sampleAnswer?: string;
  sourceAttribution?: string;
  targetChunks?: string[];
  sourceAudioText?: string;
  audioUrl?: string;
  interactiveReading?: InteractiveReadingData;
  readAndComplete?: ReadAndCompleteData;
  difficulty: number | 'easy' | 'mid' | 'hard';
  tags: string[];
  srs?: SRSData;
}

export interface EvalPrompt {
  id: string;
  name: string;
  appliesToType: BlockType;
  promptText: string;
  scoreScale: ScoreScale;
}

export interface Block {
  id: string;
  name: string;
  type: BlockType;
  durationSec: number;
  instructions: string;
  questionSetId?: string;
  preferredQuestionType?: DETQuestionType | 'adaptive';
  autoAdvance: boolean;
  evalPromptId: string;
}

export type BlockConfig = Block;

export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  blocks: Block[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface AIFeedback {
  overallScore?: number;
  subscores: Record<string, number>;
  criteria: Record<string, string>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  suggestedFix?: string;
  note?: string;
}

export interface BlockResponse {
  blockId: string;
  type?: BlockType;
  questionType?: string;
  questionId?: string;
  promptSnapshot?: string;
  textOrTranscript?: string;
  timestampedTranscript?: string;
  audioDurationSec?: number;
  fragmentNotes?: string;
  attemptCount?: number;
  previousDraft?: string;
  audioBlobRef?: string;
  isComplete: boolean;
  timeSpentSec: number;
  fillerCount?: number;
  wpm?: number;
  aiSubscores?: Record<string, number>;
  aiOverallScore?: number;
  aiFeedback?: AIFeedback;
  evalPendingOffline?: boolean;
}

export interface SessionSummary {
  overallScore?: number;
  perSkillScores?: Partial<Record<DETSkill, number>>;
  durationSec: number;
}

export interface SessionRun {
  id: string;
  templateId: string | null;
  templateName: string;
  blockConfigs: BlockConfig[];
  status: SessionStatus;
  currentBlockIndex: number;
  overallElapsedSec: number;
  instantFeedback?: boolean;
  communicativePressure?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  startedAt: string;
  endedAt: string | null;
  responses: Record<string, BlockResponse>;
  summary?: SessionSummary;
}
`,

  // =========================================================================
  // 2. INTERACTIVE READING & READ-AND-COMPLETE BLOCK (Real DET UI)
  // =========================================================================
  'src/components/exam/blocks/InteractiveReadingBlock.tsx': `import { useState, useEffect, useMemo } from 'react';
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
        wrongDetails.push(\`Blank [\${b.id}]: chose "\${clozeAnswers[b.id] || 'none'}" (Correct: "\${b.correctAnswer}")\`);
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
      wrongDetails.length > 0 ? \`Mistakes: \${wrongDetails.join(' | ')}\` : 'Zero errors across all 6 steps!',
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
        missedWords.push(\`\${b.prefix}[\${b.missingSuffix}] (you typed: "\${b.prefix}\${userSuffix}")\`);
      }
    }

    const accuracy = earned / Math.max(1, total);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedCloze(true);

    const summaryTranscript = \`[Read and Complete — \${rc.sourceName}] Score: \${earned}/\${total} (\${detScore}/160). \${
      missedWords.length > 0 ? 'Missed: ' + missedWords.join(', ') : 'All words completed accurately!'
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
        strengths: earned >= total - 2 ? ['Strong orthographic & collocation recall'] : ['Completed C-test passage'],
        weaknesses: missedWords,
        suggestions: ['Look at prepositions and grammatical suffixes (-tion, -ive, -ly) following each blank.'],
      },
    });
  };

  // Render Paragraph 1 with embedded dropdowns for Step 0 (Complete the Sentences)
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
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
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
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
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
            {rc.passageWithBlanks.split(/(\\{\\{\\d+\\}\\})/g).map((part, idx) => {
              const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
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
                    style={{ width: \`\${Math.max(4, blank.missingSuffix.length + 1)}ch\` }}
                    placeholder={'_'.repeat(blank.missingSuffix.length)}
                    className={\`font-mono text-sm font-bold border-b-2 focus:outline-none px-0.5 \${
                      isCorrect
                        ? 'border-green-600 text-green-700 bg-green-50'
                        : isWrong
                        ? 'border-red-600 text-red-700 bg-red-50'
                        : 'border-primary-500 text-primary-700'
                    }\`}
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
`,

  // =========================================================================
  // 3. MOCK TEST BLOCK: Automatically render InteractiveReadingBlock for Reading
  // =========================================================================
  'src/components/exam/blocks/MockTestBlock.tsx': `import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import { InteractiveReadingBlock } from './InteractiveReadingBlock';
import type { BlockConfig, QuestionBankItem, DETQuestionType, DETSkill } from '../../../types';

const QUESTION_TYPE_LABELS: { value: DETQuestionType | 'adaptive'; label: string }[] = [
  { value: 'adaptive', label: '🎯 Adaptive (Targets Weakest Skill)' },
  { value: 'interactive-reading', label: '📖 Interactive Reading (BBC / The Conversation)' },
  { value: 'read-and-complete', label: '✍️ Read & Complete (Prefix Cloze)' },
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
        ? 'interactive-reading'
        : activeRun?.preferredQuestionType) ??
      'interactive-reading'
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
  // 4. BLOCK INPUT ROUTER: Route 'interactive-reading'
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
  // 5. DATABASE: Seed 30+ Authentic BBC / The Conversation Questions & Reading
  // =========================================================================
  'src/db/database.ts': `import Dexie, { type Table } from 'dexie';
import type {
  Settings,
  QuestionBankItem,
  EvalPrompt,
  SessionTemplate,
  SessionRun,
} from '../types';

export const DEFAULT_WRITING_PROMPT = \`You are an expert Duolingo English Test (DET) evaluator. Grade the provided response against the official DET rubric, strictly calibrating for a target score band of 140-150 (C1/C2 graduate proficiency). Focus on syntactic complexity (subordination, embedded clauses), collocation accuracy, and cohesive transitions.

Task / Prompt: {{prompt}}
Verified Time Spent: {{durationSec}} seconds
Student Response:
{{response}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "grammar": "<concise grammar/clause critique>", "vocabulary": "<collocation/chunk assessment>", "coherence": "<transitions assessment>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<specific recurring error 1>", "<specific error 2>"],
  "suggestions": ["<actionable fix 1>", "<actionable fix 2>"],
  "suggestedFix": "<A 150-band C1/C2 rewrite of the student's weakest sentences>"
}\`;

export const DEFAULT_SPEAKING_PROMPT = \`You are an expert Duolingo English Test (DET) speaking evaluator. Grade the verbatim timestamped speech transcript against the official DET rubric for a target score band of 140-150.

CRITICAL TIMING & TIMESTAMP INSTRUCTIONS:
1. The student's ACTUAL verified total audio recording duration is {{durationSec}} seconds (Speaking rate: {{wpm}} WPM, Fillers detected: {{fillerCount}}). NEVER claim the student spoke for less than {{durationSec}} seconds.
2. The transcript includes exact segment timestamps [start - end] and [PAUSE Xs] markers generated by Faster-Whisper. Use these timestamps to evaluate acoustic fluency, clause-boundary pacing, hesitation clusters ("uh", "um"), and mid-clause pauses.

Speaking Task / Prompt: {{prompt}}
Verified Total Recording Duration: {{durationSec}} seconds ({{wpm}} WPM, {{fillerCount}} fillers)
Timestamped Verbatim Transcript:
{{transcript}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "fluency": "<pace, [PAUSE] analysis & duration assessment>", "lexical_diversity": "<collocations & academic chunks>", "grammar": "<spoken syntactic complexity>" },
  "strengths": ["<strength 1>", "<strength 2>"],
  "weaknesses": ["<specific fluency/grammar gap 1>", "<specific gap 2>"],
  "suggestions": ["<specific tip 1>", "<specific tip 2>"],
  "suggestedFix": "<A polished 150-score spoken version incorporating high-level collocations>"
}\`;

export const DEFAULT_SHADOWING_PROMPT = \`You are an SLA speech prosody and shadowing evaluator. Compare the source native passage against the student's simultaneous shadowed transcript (recorded over {{durationSec}} seconds). Evaluate word retention, chunk automaticity, and hesitation markers.

Source Native Passage:
{{prompt}}

Student Shadowed Timestamped Transcript ({{durationSec}}s):
{{transcript}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "fluency": "<rhythm & pause synchronization>", "accuracy": "<dropped words or stumbled chunks>", "grammar": "<structural retention>" },
  "strengths": ["<strength 1>"],
  "weaknesses": ["<dropped or hesitated chunk>"],
  "suggestions": ["<motor-auditory shadowing drill tip>"],
  "suggestedFix": "<Key multi-word chunks from the source passage to drill aloud>"
}\`;

export const DEFAULT_DICTOGLOSS_PROMPT = \`You are an SLA Dictogloss working-memory and syntactic reconstruction evaluator. Grade how accurately the student reconstructed the core meaning of the source lecture passage using their own complex subordination and academic collocations (do NOT require verbatim word matching).

Original Lecture Passage:
{{prompt}}

Student Reconstructed Text (Time spent: {{durationSec}}s):
{{response}}

Return ONLY a valid JSON object matching this exact schema:
{
  "overallScore": <number 0-160>,
  "subscores": { "literacy": <0-160>, "comprehension": <0-160>, "conversation": <0-160>, "production": <0-160> },
  "criteria": { "comprehension": "<retention of core thesis & causal links>", "grammar": "<subordination & clause embedding>", "vocabulary": "<academic collocations>" },
  "strengths": ["<strength 1>"],
  "weaknesses": ["<missing nuance or syntactic weakness>"],
  "suggestions": ["<note-taking compression or syntax tip>"],
  "suggestedFix": "<A 150-band C1/C2 reconstruction of the passage>"
}\`;

export function buildRichQuestionBank(): QuestionBankItem[] {
  return [
    // =====================================================================
    // 1. INTERACTIVE READING (6-Step Suites from BBC & The Conversation)
    // =====================================================================
    {
      id: 'ir-conversation-optogenetics',
      skill: 'reading',
      type: 'interactive-reading',
      sourceAttribution: 'The Conversation (Neuroscience)',
      prompt: 'Interactive Reading: Optogenetics and Controlling Brain Cells with Light (The Conversation)',
      difficulty: 'hard',
      tags: ['interactive-reading', 'the-conversation', 'neuroscience'],
      interactiveReading: {
        sourceName: 'The Conversation — Neuroscience & Optogenetics',
        paragraph1WithBlanks:
          'A discovery in tiny green algae has led to a breakthrough technique known as optogenetics, which allows neuroscientists to {{1}} specific brain cells on and off using beams of light. When light hits a light-sensitive molecule called retinaldehyde inside the channelrhodopsin protein, the molecule {{2}} its physical shape. This structural shift opens a microscopic {{3}} through the cell membrane, allowing positively charged sodium ions to flow rapidly into the neuron and {{4}} an electrical signal.',
        paragraph1Sentences: [
          'A discovery in tiny green algae has led to a breakthrough technique known as optogenetics, which allows neuroscientists to switch specific brain cells on and off using beams of light.',
          'When light hits a light-sensitive molecule called retinaldehyde inside the channelrhodopsin protein, the molecule alters its physical shape.',
          'This structural shift opens a microscopic passage through the cell membrane, allowing positively charged sodium ions to flow rapidly into the neuron and trigger an electrical signal.',
        ],
        blanks: [
          { id: '1', options: ['switch', 'dissolve', 'obscure', 'postpone'], correctAnswer: 'switch' },
          { id: '2', options: ['alters', 'ignores', 'forbids', 'depletes'], correctAnswer: 'alters' },
          { id: '3', options: ['passage', 'obstacle', 'illusion', 'sediment'], correctAnswer: 'passage' },
          { id: '4', options: ['trigger', 'suppress', 'abandon', 'conceal'], correctAnswer: 'trigger' },
        ],
        passageGapOptions: [
          'By inserting the genes for these algal proteins into specific mammalian neurons, researchers gained unprecedented control over living neural circuits.',
          'Nevertheless, marine biologists argue that freshwater algae cannot survive outside tropical ocean currents.',
          'Consequently, traditional pharmaceutical drugs have completely replaced optical fibers in all modern hospitals.',
          'In contrast, sodium ions are entirely absent from the nervous systems of vertebrate animals.',
        ],
        correctPassageGap:
          'By inserting the genes for these algal proteins into specific mammalian neurons, researchers gained unprecedented control over living neural circuits.',
        paragraph2Sentences: [
          'In a landmark experiment, scientists used optogenetics to tag the exact nerve cells in the mouse brain memory center that were active during a fear-conditioning trial.',
          'Days later, when researchers switched those tagged cells back on with a laser in a completely safe environment, the mice immediately froze in fear.',
          'Control mice that had not undergone the initial conditioning did not freeze, proving that the light pulse was reactivating a specific stored memory.',
          'Today, this precision tool is opening clinical possibilities for restoring lost vision in retinal disease and regulating abnormal neural rhythms in Parkinsonian disorders.',
        ],
        highlightQuestion1:
          'Click the sentence that explains what physically happens to the cell membrane when retinaldehyde changes shape.',
        correctHighlight1:
          'This structural shift opens a microscopic passage through the cell membrane, allowing positively charged sodium ions to flow rapidly into the neuron and trigger an electrical signal.',
        highlightQuestion2:
          'Click the sentence that proves the laser light was reactivating a genuine memory rather than causing an automatic reflex in all mice.',
        correctHighlight2:
          'Control mice that had not undergone the initial conditioning did not freeze, proving that the light pulse was reactivating a specific stored memory.',
        mainIdeaOptions: [
          'Light-sensitive proteins derived from algae enable scientists to precisely control neurons, reactivate specific memories, and explore targeted treatments for neurological disorders.',
          'Green algae rely on sodium ions to navigate toward sunlight in deep freshwater lakes.',
          'Fear conditioning in rodents permanently damages the retinaldehyde molecules inside the visual cortex.',
          'Laser surgery has become the primary method for removing damaged tissue in patients with Parkinsonian disorders.',
        ],
        correctMainIdea:
          'Light-sensitive proteins derived from algae enable scientists to precisely control neurons, reactivate specific memories, and explore targeted treatments for neurological disorders.',
        titleOptions: [
          'Illuminating the Brain: How Algal Proteins Unlocked Optical Control of Neurons',
          'The Ecological Decline of Green Algae in Freshwater Habitats',
          'Why Pharmaceutical Treatments Fail to Cross the Cell Membrane',
          'A History of Laser Manufacturing in Modern Ophthalmology',
        ],
        correctTitle:
          'Illuminating the Brain: How Algal Proteins Unlocked Optical Control of Neurons',
      },
    },
    {
      id: 'ir-bbc-atlantic-mosquitoes',
      skill: 'reading',
      type: 'interactive-reading',
      sourceAttribution: 'BBC Science Focus (Ecology & Epidemiology)',
      prompt: 'Interactive Reading: Biodiversity Loss and Mosquito Host Shifts in Brazil (BBC Science Focus)',
      difficulty: 'hard',
      tags: ['interactive-reading', 'bbc', 'ecology'],
      interactiveReading: {
        sourceName: 'BBC Science Focus — Ecology & Vector-Borne Disease',
        paragraph1WithBlanks:
          'Disease-carrying mosquitoes in Brazil’s Atlantic Forest are increasingly {{1}} humans over wild animals, raising urgent concerns that habitat degradation is pushing dangerous vectors closer to human settlements. When researchers captured engorged female mosquitoes inside protected nature reserves and sequenced the DNA of their blood meals, they discovered a striking {{2}} for human hosts. Nearly three-quarters of the analyzed blood meals originated from humans, a finding that {{3}} the research team given that the light traps were positioned deep inside forested reserves with {{4}} human presence.',
        paragraph1Sentences: [
          'Disease-carrying mosquitoes in Brazil’s Atlantic Forest are increasingly targeting humans over wild animals, raising urgent concerns that habitat degradation is pushing dangerous vectors closer to human settlements.',
          'When researchers captured engorged female mosquitoes inside protected nature reserves and sequenced the DNA of their blood meals, they discovered a striking preference for human hosts.',
          'Nearly three-quarters of the analyzed blood meals originated from humans, a finding that surprised the research team given that the light traps were positioned deep inside forested reserves with minimal human presence.',
        ],
        blanks: [
          { id: '1', options: ['targeting', 'evading', 'nourishing', 'sheltering'], correctAnswer: 'targeting' },
          { id: '2', options: ['preference', 'aversion', 'indifference', 'immunity'], correctAnswer: 'preference' },
          { id: '3', options: ['surprised', 'reassured', 'discredited', 'pacified'], correctAnswer: 'surprised' },
          { id: '4', options: ['minimal', 'excessive', 'universal', 'mandatory'], correctAnswer: 'minimal' },
        ],
        passageGapOptions: [
          'The genetic evidence suggests that mosquitoes are flying out of the forest reserves to feed on nearby residents before returning to the canopy to rest.',
          'As a result, entomologists concluded that female mosquitoes no longer require blood meals to develop their eggs.',
          'Meanwhile, urban architects have begun constructing taller apartment buildings across South America.',
          'Conversely, DNA sequencing cannot distinguish between mammalian and avian blood samples.',
        ],
        correctPassageGap:
          'The genetic evidence suggests that mosquitoes are flying out of the forest reserves to feed on nearby residents before returning to the canopy to rest.',
        paragraph2Sentences: [
          'Ecological degradation around the reserves is playing a decisive role in driving this behavioral shift.',
          'As deforestation fragments the surrounding landscape, the wild vertebrates that mosquitoes normally feed upon become scarce, forcing the insects to seek alternative hosts.',
          'This adaptation is alarming because these vectors transmit severe pathogens, including dengue, Zika, malaria, and yellow fever.',
          'Researchers emphasize that preserving intact forest buffers and maintaining ecological equilibrium is essential to prevent mosquitoes from permanently adapting to human blood.',
        ],
        highlightQuestion1:
          'Click the sentence that explains the laboratory method scientists used to determine which species the mosquitoes had bitten.',
        correctHighlight1:
          'When researchers captured engorged female mosquitoes inside protected nature reserves and sequenced the DNA of their blood meals, they discovered a striking preference for human hosts.',
        highlightQuestion2:
          'Click the sentence that explains why the loss of surrounding forest forces mosquitoes to change their feeding behavior.',
        correctHighlight2:
          'As deforestation fragments the surrounding landscape, the wild vertebrates that mosquitoes normally feed upon become scarce, forcing the insects to seek alternative hosts.',
        mainIdeaOptions: [
          'Deforestation and declining wildlife populations are driving forest mosquitoes to feed predominantly on humans, elevating the risk of vector-borne disease outbreaks.',
          'Light traps placed one kilometer inside nature reserves are ineffective at capturing female mosquitoes.',
          'DNA sequencing has eradicated yellow fever and dengue across Brazil’s Atlantic Forest.',
          'Wild vertebrates in tropical reserves have developed natural immunity to mosquito bites.',
        ],
        correctMainIdea:
          'Deforestation and declining wildlife populations are driving forest mosquitoes to feed predominantly on humans, elevating the risk of vector-borne disease outbreaks.',
        titleOptions: [
          'Driven by Deforestation: Why Forest Mosquitoes Are Developing a Taste for Human Blood',
          'Advances in Light-Trap Engineering for Tropical Entomology',
          'The Complete Eradication of Malaria in South American Cities',
          'How Urbanization Increases Wildlife Populations in Nature Reserves',
        ],
        correctTitle:
          'Driven by Deforestation: Why Forest Mosquitoes Are Developing a Taste for Human Blood',
      },
    },
    {
      id: 'ir-bbc-synthetic-cell',
      skill: 'reading',
      type: 'interactive-reading',
      sourceAttribution: 'BBC Science Focus (Synthetic Biology)',
      prompt: 'Interactive Reading: Building Synthetic Life from Scratch (BBC Science Focus)',
      difficulty: 'hard',
      tags: ['interactive-reading', 'bbc', 'biology'],
      interactiveReading: {
        sourceName: 'BBC Science Focus — Synthetic Biology',
        paragraph1WithBlanks:
          'Biochemists have engineered the world’s first synthetic cell-like system capable of growing, {{1}}, and repeating a complete cell cycle from chemical components. Because living organisms are {{2}} complex, biologists have long struggled to distinguish which cellular mechanisms are strictly essential for life and which are merely evolutionary extras. By constructing a simplified artificial cell from the bottom up, researchers can {{3}} individual biological variables one by one and prove that fundamental processes like replication do not require a mysterious {{4}} spark.',
        paragraph1Sentences: [
          'Biochemists have engineered the world’s first synthetic cell-like system capable of growing, dividing, and repeating a complete cell cycle from chemical components.',
          'Because living organisms are extraordinarily complex, biologists have long struggled to distinguish which cellular mechanisms are strictly essential for life and which are merely evolutionary extras.',
          'By constructing a simplified artificial cell from the bottom up, researchers can isolate individual biological variables one by one and prove that fundamental processes like replication do not require a mysterious vital spark.',
        ],
        blanks: [
          { id: '1', options: ['dividing', 'vanishing', 'petrifying', 'conceding'], correctAnswer: 'dividing' },
          { id: '2', options: ['extraordinarily', 'negligibly', 'reluctantly', 'superficially'], correctAnswer: 'extraordinarily' },
          { id: '3', options: ['isolate', 'confuse', 'Conceal', 'discard'], correctAnswer: 'isolate' },
          { id: '4', options: ['vital', 'trivial', 'dormant', 'obsolete'], correctAnswer: 'vital' },
        ],
        passageGapOptions: [
          'Despite this milestone in chemical replication, the synthetic cell cannot yet survive independently without external molecular support.',
          'Therefore, all natural bacteria have ceased producing proteins in laboratory environments.',
          'In addition, fluorescent microscopy was outlawed by international chemistry conventions.',
          'However, synthetic cells are already larger and more complex than multicellular mammals.',
        ],
        correctPassageGap:
          'Despite this milestone in chemical replication, the synthetic cell cannot yet survive independently without external molecular support.',
        paragraph2Sentences: [
          'Specifically, the artificial cell lacks the ability to manufacture its own ribosomes, the microscopic molecular machines responsible for assembling proteins.',
          'Instead, the synthetic system must borrow functional ribosomes from specially engineered external support structures.',
          'If these findings hold up under rigorous peer review, scientists believe the platform will usher in a new generation of programmable biological engineering.',
        ],
        highlightQuestion1:
          'Click the sentence that explains why studying natural living cells makes it difficult to identify the minimum requirements for life.',
        correctHighlight1:
          'Because living organisms are extraordinarily complex, biologists have long struggled to distinguish which cellular mechanisms are strictly essential for life and which are merely evolutionary extras.',
        highlightQuestion2:
          'Click the sentence that identifies the specific molecular machinery the synthetic cell is currently unable to build on its own.',
        correctHighlight2:
          'Specifically, the artificial cell lacks the ability to manufacture its own ribosomes, the microscopic molecular machines responsible for assembling proteins.',
        mainIdeaOptions: [
          'Researchers have created a simplified synthetic cell that can grow and divide chemically, offering a powerful model to study the fundamental mechanics of life despite still relying on borrowed ribosomes.',
          'Ribosomes are no longer necessary for protein synthesis in modern biological organisms.',
          'Synthetic cells have completely replaced natural microorganisms in agricultural production.',
          'Peer review has disproven the possibility of replicating cellular membranes in a chemistry lab.',
        ],
        correctMainIdea:
          'Researchers have created a simplified synthetic cell that can grow and divide chemically, offering a powerful model to study the fundamental mechanics of life despite still relying on borrowed ribosomes.',
        titleOptions: [
          'Life from Scratch: How a Dividing Synthetic Cell Is Redefining Biology',
          'The History of Fluorescent Microscopy in Nineteenth-Century Chemistry',
          'Why Ribosomes Prevent Natural Cells from Dividing',
          'Eliminating Protein Synthesis in Multicellular Organisms',
        ],
        correctTitle:
          'Life from Scratch: How a Dividing Synthetic Cell Is Redefining Biology',
      },
    },
    {
      id: 'ir-bbc-heatwaves-brain',
      skill: 'reading',
      type: 'interactive-reading',
      sourceAttribution: 'BBC Science Focus (Neurobiology & Climate)',
      prompt: 'Interactive Reading: How Extreme Heatwaves Disrupt Human Brain Function (BBC Science Focus)',
      difficulty: 'hard',
      tags: ['interactive-reading', 'bbc', 'neuroscience', 'climate'],
      interactiveReading: {
        sourceName: 'BBC Science Focus — Neurobiology & Climate Health',
        paragraph1WithBlanks:
          'More frequent and intense heatwaves are not merely damaging ecosystems; they are directly {{1}} human cognitive function and neurological stability. Brain cells operate within a narrow optimal thermal window, and when ambient temperatures climb above that threshold, synaptic interactions become increasingly {{2}}. A neuron’s ability to fire relies on specialized proteins fitting into receptor sockets like a lock and key, but excessive heat causes these molecular keys to {{3}} their precise three-dimensional shape and {{4}} signal transmission.',
        paragraph1Sentences: [
          'More frequent and intense heatwaves are not merely damaging ecosystems; they are directly impairing human cognitive function and neurological stability.',
          'Brain cells operate within a narrow optimal thermal window, and when ambient temperatures climb above that threshold, synaptic interactions become increasingly erratic.',
          'A neuron’s ability to fire relies on specialized proteins fitting into receptor sockets like a lock and key, but excessive heat causes these molecular keys to lose their precise three-dimensional shape and misfire signal transmission.',
        ],
        blanks: [
          { id: '1', options: ['impairing', 'enhancing', 'insulating', 'celebrating'], correctAnswer: 'impairing' },
          { id: '2', options: ['erratic', 'infallible', 'dormant', 'effortless'], correctAnswer: 'erratic' },
          { id: '3', options: ['lose', 'solidify', 'multiply', 'duplicate'], correctAnswer: 'lose' },
          { id: '4', options: ['misfire', 'accelerate', 'purify', 'Guaranteed'], correctAnswer: 'misfire' },
        ],
        passageGapOptions: [
          'Compound this cellular disruption with the fact that extreme heat also compromises the blood-brain barrier and disrupts restorative slow-wave sleep.',
          'Consequently, neurons function with far greater speed and accuracy during severe summer droughts.',
          'On the other hand, receptor sockets are made of inorganic minerals that never react to temperature.',
          'For this reason, neuroscientists recommend eliminating shade trees from metropolitan neighborhoods.',
        ],
        correctPassageGap:
          'Compound this cellular disruption with the fact that extreme heat also compromises the blood-brain barrier and disrupts restorative slow-wave sleep.',
        paragraph2Sentences: [
          'Epidemiological data reveals that hospital admissions for neurological and mood disorders spike measurably during prolonged periods of extreme heat.',
          'Decision-making, impulse control, and working memory degrade first as the prefrontal cortex struggles to regulate internal thermal stress.',
          'Urban planners and public health officials must therefore treat urban cooling infrastructure not just as an environmental amenity, but as a critical safeguard for population brain health.',
        ],
        highlightQuestion1:
          'Click the sentence that uses a mechanical analogy to explain how heat interferes with synaptic receptors.',
        correctHighlight1:
          'A neuron’s ability to fire relies on specialized proteins fitting into receptor sockets like a lock and key, but excessive heat causes these molecular keys to lose their precise three-dimensional shape and misfire signal transmission.',
        highlightQuestion2:
          'Click the sentence that specifies which cognitive faculties deteriorate earliest when the brain experiences thermal stress.',
        correctHighlight2:
          'Decision-making, impulse control, and working memory degrade first as the prefrontal cortex struggles to regulate internal thermal stress.',
        mainIdeaOptions: [
          'Extreme heatwaves deform neural proteins and impair prefrontal cortex function, making urban cooling essential for protecting cognitive and neurological health.',
          'The human brain adapts effortlessly to extreme heat by expanding the blood-brain barrier.',
          'Prefrontal cortex activity increases significantly during prolonged summer heatwaves.',
          'Hospital admissions for neurological conditions decline when ambient temperatures exceed optimal thresholds.',
        ],
        correctMainIdea:
          'Extreme heatwaves deform neural proteins and impair prefrontal cortex function, making urban cooling essential for protecting cognitive and neurological health.',
        titleOptions: [
          'The Overheated Mind: How Rising Temperatures Disrupt Neural Signaling',
          'Why Synaptic Proteins Require High Temperatures to Replicate',
          'The Architecture of Lock-and-Key Security Systems',
          'How Slow-Wave Sleep Eliminates Urban Heat Islands',
        ],
        correctTitle:
          'The Overheated Mind: How Rising Temperatures Disrupt Neural Signaling',
      },
    },
    {
      id: 'ir-conversation-ai-economics',
      skill: 'reading',
      type: 'interactive-reading',
      sourceAttribution: 'The Conversation / Nobel Economic Dialogues',
      prompt: 'Interactive Reading: Artificial Intelligence, Idea Recombination, and Labor Transitions (The Conversation)',
      difficulty: 'hard',
      tags: ['interactive-reading', 'the-conversation', 'economics', 'ai'],
      interactiveReading: {
        sourceName: 'The Conversation — Economics of Artificial Intelligence',
        paragraph1WithBlanks:
          'Economists studying technological revolutions emphasize that there is no {{1}} law guaranteeing that powerful technologies automatically produce broadly shared prosperity. Throughout history, economic innovation has functioned primarily through the {{2}} of existing ideas to generate novel industrial processes and new categories of work. While generative artificial intelligence can {{3}} this recombinant discovery process across scientific disciplines, its macroeconomic impact depends heavily on whether institutions {{4}} the technology toward augmenting human workers rather than merely automating routine labor.',
        paragraph1Sentences: [
          'Economists studying technological revolutions emphasize that there is no universal law guaranteeing that powerful technologies automatically produce broadly shared prosperity.',
          'Throughout history, economic innovation has functioned primarily through the recombination of existing ideas to generate novel industrial processes and new categories of work.',
          'While generative artificial intelligence can accelerate this recombinant discovery process across scientific disciplines, its macroeconomic impact depends heavily on whether institutions steer the technology toward augmenting human workers rather than merely automating routine labor.',
        ],
        blanks: [
          { id: '1', options: ['universal', 'fragile', 'temporary', 'accidental'], correctAnswer: 'universal' },
          { id: '2', options: ['recombination', 'eradication', 'isolation', 'concealment'], correctAnswer: 'recombination' },
          { id: '3', options: ['accelerate', 'prohibit', 'relinquish', 'diminish'], correctAnswer: 'accelerate' },
          { id: '4', options: ['steer', 'abandon', 'conceal', 'surrender'], correctAnswer: 'steer' },
        ],
        passageGapOptions: [
          'Without deliberate policy guardrails and democratic participation, rapid automation risks displacing workers faster than the economy can transition them into emerging roles.',
          'Consequently, economists agree that scientific experimentation should be permanently halted across all universities.',
          'In contrast, historical technologies never required workers to learn new skills or adapt to new industries.',
          'Therefore, corporate profits have declined to zero in every sector adopting machine learning.',
        ],
        correctPassageGap:
          'Without deliberate policy guardrails and democratic participation, rapid automation risks displacing workers faster than the economy can transition them into emerging roles.',
        paragraph2Sentences: [
          'The central policy challenge is therefore smoothing the institutional transition from obsolete tasks to newly created, high-productivity occupations.',
          'Achieving a socially beneficial trajectory requires that independent scientists, labor representatives, and public thinkers hold a seat at the regulatory table.',
          'When governance frameworks prioritize human complementarity over unchecked cost-cutting, artificial intelligence can expand collective capability rather than deepen economic inequality.',
        ],
        highlightQuestion1:
          'Click the sentence that explains the historical mechanism by which new ideas and new jobs are generated.',
        correctHighlight1:
          'Throughout history, economic innovation has functioned primarily through the recombination of existing ideas to generate novel industrial processes and new categories of work.',
        highlightQuestion2:
          'Click the sentence that defines the primary policy challenge facing governments during an AI-driven labor transition.',
        correctHighlight2:
          'The central policy challenge is therefore smoothing the institutional transition from obsolete tasks to newly created, high-productivity occupations.',
        mainIdeaOptions: [
          'Whether artificial intelligence yields shared prosperity or disruptive inequality depends on institutional governance that steers AI toward human augmentation and smooths labor transitions.',
          'Technological progress follows an automatic economic law that guarantees equal wealth distribution without regulation.',
          'Artificial intelligence prevents scientists from recombining older ideas into new discoveries.',
          'Economists recommend replacing all human decision-makers with autonomous corporate algorithms.',
        ],
        correctMainIdea:
          'Whether artificial intelligence yields shared prosperity or disruptive inequality depends on institutional governance that steers AI toward human augmentation and smooths labor transitions.',
        titleOptions: [
          'Governing the Transition: Why AI Prosperity Requires Institutional Steering',
          'The Mathematical Inevitability of Technological Unemployment',
          'Why Scientific Discovery No Longer Relies on Data Quality',
          'Abolishing Regulatory Frameworks in the Digital Economy',
        ],
        correctTitle:
          'Governing the Transition: Why AI Prosperity Requires Institutional Steering',
      },
    },

    // =====================================================================
    // 2. READ AND COMPLETE (Authentic C-Test Prefix Cloze from BBC & The Conversation)
    // =====================================================================
    {
      id: 'rc-bbc-acoustic-alzheimers',
      skill: 'reading',
      type: 'read-and-complete',
      sourceAttribution: 'BBC Science Focus (Neurology)',
      prompt: 'Read and Complete: Acoustic Stimulation and Brain Plaque Clearance (BBC Science Focus)',
      difficulty: 'hard',
      tags: ['read-and-complete', 'bbc', 'neuroscience'],
      readAndComplete: {
        sourceName: 'BBC Science Focus — Neurology',
        title: 'Acoustic Stimulation and Neural Waste Clearance',
        passageWithBlanks:
          'Non-invasive sound stimulation may help resynchronize brain {{1}} and restore the timing signals that instruct neural cleaning {{2}} when and where to clear toxic plaques. In a recent primate trial, subjects exposed to calibrated acoustic tones for one {{3}} daily exhibited a 200 percent {{4}} in beta-amyloid clearance within their cerebrospinal {{5}}. Remarkably, these elevated clearance levels {{6}} for five weeks after the trial concluded, offering a {{7}} clue for future neurodegenerative therapies.',
        blanks: [
          { id: '1', prefix: 'act', missingSuffix: 'ivity', fullWord: 'activity' },
          { id: '2', prefix: 'sys', missingSuffix: 'tems', fullWord: 'systems' },
          { id: '3', prefix: 'ho', missingSuffix: 'ur', fullWord: 'hour' },
          { id: '4', prefix: 'inc', missingSuffix: 'rease', fullWord: 'increase' },
          { id: '5', prefix: 'fl', missingSuffix: 'uid', fullWord: 'fluid' },
          { id: '6', prefix: 'pers', missingSuffix: 'isted', fullWord: 'persisted' },
          { id: '7', prefix: 'prom', missingSuffix: 'ising', fullWord: 'promising' },
        ],
      },
    },
    {
      id: 'rc-conversation-orbital-datacenters',
      skill: 'reading',
      type: 'read-and-complete',
      sourceAttribution: 'The Conversation / Space Technology',
      prompt: 'Read and Complete: Orbital Data Centers and Sustainable Computing',
      difficulty: 'hard',
      tags: ['read-and-complete', 'the-conversation', 'technology'],
      readAndComplete: {
        sourceName: 'The Conversation — Sustainable Computing',
        title: 'Orbital Data Centers in Low Earth Orbit',
        passageWithBlanks:
          'As artificial intelligence drives an unprecedented surge in global {{1}} demand, aerospace engineers are exploring orbital data {{2}} powered by continuous solar {{3}} in space. Even after accounting for the carbon {{4}} generated by rocket launches, processing data in orbit could {{5}} the environmental footprint of cloud computing while relieving {{6}} on terrestrial power {{7}}.',
        blanks: [
          { id: '1', prefix: 'elect', missingSuffix: 'ricity', fullWord: 'electricity' },
          { id: '2', prefix: 'cen', missingSuffix: 'ters', fullWord: 'centers' },
          { id: '3', prefix: 'rad', missingSuffix: 'iation', fullWord: 'radiation' },
          { id: '4', prefix: 'emis', missingSuffix: 'sions', fullWord: 'emissions' },
          { id: '5', prefix: 'red', missingSuffix: 'uce', fullWord: 'reduce' },
          { id: '6', prefix: 'str', missingSuffix: 'ain', fullWord: 'strain' },
          { id: '7', prefix: 'gr', missingSuffix: 'ids', fullWord: 'grids' },
        ],
      },
    },
    {
      id: 'rc-bbc-forensic-linguistics',
      skill: 'reading',
      type: 'read-and-complete',
      sourceAttribution: 'BBC Science Focus (Forensic Linguistics)',
      prompt: 'Read and Complete: Detecting Deception Through Verbal Language Patterns (BBC Science Focus)',
      difficulty: 'hard',
      tags: ['read-and-complete', 'bbc', 'psychology'],
      readAndComplete: {
        sourceName: 'BBC Science Focus — Forensic Linguistics',
        title: 'Verbal Clues to Deception',
        passageWithBlanks:
          'Contrary to popular belief, body language is an unreliable {{1}} of deception, whereas verbal language contains measurable {{2}} clues. Forensic linguists have demonstrated that individuals fabricating a story often use fewer first-person {{3}} to distance themselves psychologically from their {{4}}. Furthermore, the cognitive load of maintaining a false {{5}} frequently reduces syntactic {{6}} and sensory detail.',
        blanks: [
          { id: '1', prefix: 'ind', missingSuffix: 'icator', fullWord: 'indicator' },
          { id: '2', prefix: 'ling', missingSuffix: 'uistic', fullWord: 'linguistic' },
          { id: '3', prefix: 'pron', missingSuffix: 'ouns', fullWord: 'pronouns' },
          { id: '4', prefix: 'stat', missingSuffix: 'ements', fullWord: 'statements' },
          { id: '5', prefix: 'narr', missingSuffix: 'ative', fullWord: 'narrative' },
          { id: '6', prefix: 'comp', missingSuffix: 'lexity', fullWord: 'complexity' },
        ],
      },
    },

    // =====================================================================
    // 3. COLLOCATION CHUNK WRITING (SRS Multi-Word Chunks)
    // =====================================================================
    {
      id: 'vw-chunks-ai-research',
      skill: 'writing',
      type: 'write-about-photo',
      sourceAttribution: 'DET C1/C2 Collocation Bank',
      prompt: 'Write an analytical paragraph on artificial intelligence in scientific research incorporating all 4 multi-word collocation chunks below.',
      targetChunks: [
        'rigorous empirical validation',
        'shift the research paradigm',
        'ubiquitous adoption of',
        'bear the consequences',
      ],
      sampleAnswer:
        'In modern computer science, the ubiquitous adoption of machine learning has begun to shift the research paradigm, requiring rigorous empirical validation so institutions do not bear the consequences of unverified automated models.',
      difficulty: 'hard',
      tags: ['vocab', 'chunks', 'academic', 'graduate'],
    },
    {
      id: 'vw-chunks-algorithmic-governance',
      skill: 'writing',
      type: 'write-about-photo',
      sourceAttribution: 'DET C1/C2 Collocation Bank',
      prompt: 'Write a dense academic paragraph evaluating algorithmic governance and public policy using all 4 multi-word collocation chunks below.',
      targetChunks: [
        'as a consequence of',
        'mitigate the unintended risks',
        'regulatory frameworks must evolve',
        'exercising due diligence',
      ],
      sampleAnswer:
        'As a consequence of rapid deployment in critical infrastructure, regulatory frameworks must evolve in tandem with algorithmic auditing, ensuring that engineering teams are exercising due diligence to mitigate the unintended risks of systemic bias.',
      difficulty: 'hard',
      tags: ['vocab', 'chunks', 'policy'],
    },
    {
      id: 'vw-chunks-climate-adaptation',
      skill: 'writing',
      type: 'write-about-photo',
      sourceAttribution: 'The Conversation — Climate Economics',
      prompt: 'Write an academic paragraph on climate resilience and green technology financing using all 4 multi-word collocation chunks below.',
      targetChunks: [
        'pose an existential threat to',
        'transition toward renewable infrastructure',
        'economically viable alternatives',
        'bridging the gap between',
      ],
      sampleAnswer:
        'Because rising global temperatures pose an existential threat to agricultural stability, nations must accelerate their transition toward renewable infrastructure by subsidizing economically viable alternatives and bridging the gap between scientific innovation and civic policy.',
      difficulty: 'hard',
      tags: ['vocab', 'chunks', 'climate'],
    },
    {
      id: 'vw-chunks-neurotechnology-ethics',
      skill: 'writing',
      type: 'write-about-photo',
      sourceAttribution: 'UNIDIR / The Conversation — Neurotech Ethics',
      prompt: 'Write a C1/C2 paragraph analyzing commercial brain-computer interfaces and cognitive privacy using all 4 collocation chunks below.',
      targetChunks: [
        'blurring the boundaries between',
        'unprecedented ethical dilemmas',
        'safeguard cognitive liberty',
        'susceptible to manipulation',
      ],
      sampleAnswer:
        'As neural implants begin blurring the boundaries between biological cognition and machine intelligence, they introduce unprecedented ethical dilemmas, compelling lawmakers to safeguard cognitive liberty lest human decision-making become susceptible to manipulation.',
      difficulty: 'hard',
      tags: ['vocab', 'chunks', 'neuroscience'],
    },
    {
      id: 'vw-chunks-cybersecurity-patching',
      skill: 'writing',
      type: 'write-about-photo',
      sourceAttribution: 'DET C1/C2 Engineering Bank',
      prompt: 'Write a technical policy paragraph on medical device cybersecurity and automated vulnerability patching using all 4 chunks below.',
      targetChunks: [
        'expose critical infrastructure to',
        'automated static analysis',
        'remediate security vulnerabilities',
        'without compromising system reliability',
      ],
      sampleAnswer:
        'Unpatched legacy software can expose critical infrastructure to catastrophic breaches; consequently, hospitals are integrating automated static analysis into their deployment pipelines to remediate security vulnerabilities without compromising system reliability.',
      difficulty: 'hard',
      tags: ['vocab', 'chunks', 'cybersecurity'],
    },

    // =====================================================================
    // 4. INTERACTIVE WRITING (5-Minute Argumentative & Analytical Prompts)
    // =====================================================================
    {
      id: 'iw-education-ai-defense',
      skill: 'writing',
      type: 'interactive-writing',
      sourceAttribution: 'DET Graduate Writing Bank',
      prompt: 'Universities are increasingly replacing take-home essays with live oral defenses and proctored synthesis exams due to generative AI. Evaluate the pedagogical benefits and potential drawbacks of this shift for non-native English-speaking researchers.',
      sampleAnswer:
        'While shifting toward oral defenses authenticates student comprehension and prevents uncritical reliance on generative models, universities must ensure that grading rubrics evaluate conceptual rigor rather than penalizing minor phonetic accents.',
      difficulty: 'hard',
      tags: ['writing-to-speaking', 'ai', 'education'],
    },
    {
      id: 'iw-smartphone-bans-schools',
      skill: 'writing',
      type: 'interactive-writing',
      sourceAttribution: 'BBC Science Focus — Education Research',
      prompt: 'Recent large-scale empirical studies suggest that banning mobile phones in secondary schools does not automatically improve academic grades or mental wellbeing unless paired with broader digital literacy reforms. Discuss why prohibitive bans alone often fall short.',
      sampleAnswer:
        'Prohibitive school phone bans address only a fraction of adolescent screen exposure; sustainable cognitive and emotional gains require teaching self-regulated attention management alongside restructuring algorithmically addictive platforms.',
      difficulty: 'hard',
      tags: ['education', 'psychology', 'bbc'],
    },
    {
      id: 'iw-open-source-vs-proprietary-ai',
      skill: 'writing',
      type: 'interactive-writing',
      sourceAttribution: 'The Conversation — Technology Policy',
      prompt: 'Should foundational artificial intelligence models used in scientific research and healthcare be mandated to remain open-weight and inspectable, or do security risks justify closed proprietary deployment? Present a balanced C1/C2 argument.',
      sampleAnswer:
        'Open-weight models are vital for scientific reproducibility and independent security auditing, yet high-risk biological capabilities warrant tiered access controls to prevent malicious exploitation.',
      difficulty: 'hard',
      tags: ['ai', 'cybersecurity', 'policy'],
    },

    // =====================================================================
    // 5. SPEAKING PROMPTS (90-Second Verbatim DET Speaking Drills)
    // =====================================================================
    {
      id: 'sp-ai-security-tradeoffs',
      skill: 'speaking',
      type: 'speaking-sample',
      sourceAttribution: 'DET 140-150 Speaking Bank',
      prompt: 'Speak for 90 seconds expanding on the trade-offs between rapid AI-assisted software development and rigorous security assurance. How should engineering teams validate automated code patches?',
      difficulty: 'hard',
      tags: ['speaking', 'cybersecurity', 'ai'],
    },
    {
      id: 'sp-complex-architecture',
      skill: 'speaking',
      type: 'interactive-speaking',
      sourceAttribution: 'DET 140-150 Speaking Bank',
      prompt: 'Describe a complex technical system or research project you architected or audited from scratch. How did you verify its data integrity and handle edge-case failures? Speak for 90 seconds.',
      difficulty: 'hard',
      tags: ['speaking', 'engineering', 'personal-experience'],
    },
    {
      id: 'sp-climate-computing-footprint',
      skill: 'speaking',
      type: 'speaking-sample',
      sourceAttribution: 'The Conversation — Sustainable Tech',
      prompt: 'Artificial intelligence is driving a massive surge in electricity and water consumption at data centers, yet it is also used to model climate change and optimize power grids. Speak for 90 seconds on how society should balance AI’s environmental cost against its scientific utility.',
      difficulty: 'hard',
      tags: ['speaking', 'climate', 'ai'],
    },
    {
      id: 'sp-neurotech-workplace',
      skill: 'speaking',
      type: 'interactive-speaking',
      sourceAttribution: 'UNIDIR / BBC Future',
      prompt: 'Wearable neurotechnologies may soon allow employers to monitor worker fatigue, stress, and attention levels in real time. Speak for 90 seconds on whether such monitoring should be permitted in high-stakes professions like aviation or medicine.',
      difficulty: 'hard',
      tags: ['speaking', 'neuroscience', 'ethics'],
    },

    // =====================================================================
    // 6. SHADOWING & DICTOGLOSS PASSAGES (BBC & The Conversation)
    // =====================================================================
    {
      id: 'sh-static-analysis-critics',
      skill: 'speaking',
      type: 'read-aloud',
      sourceAttribution: 'Cybersecurity & AI Research Excerpt',
      prompt: 'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
      sourceAudioText:
        'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.',
      difficulty: 'hard',
      tags: ['shadowing', 'prosody', 'cybersecurity'],
    },
    {
      id: 'sh-bbc-mosquito-equilibrium',
      skill: 'speaking',
      type: 'read-aloud',
      sourceAttribution: 'BBC Science Focus (Atlantic Forest Study)',
      prompt: 'As surrounding ecosystems degrade, the wild animals that mosquitoes normally feed upon become scarcer, pushing disease-carrying insects to seek human hosts and underscoring the urgent need to preserve intact forest buffers.',
      sourceAudioText:
        'As surrounding ecosystems degrade, the wild animals that mosquitoes normally feed upon become scarcer, pushing disease-carrying insects to seek human hosts and underscoring the urgent need to preserve intact forest buffers.',
      difficulty: 'hard',
      tags: ['shadowing', 'prosody', 'bbc'],
    },
    {
      id: 'dg-sla-chunking',
      skill: 'listening',
      type: 'listen-and-type',
      sourceAttribution: 'SLA Cognitive Science Synthesis',
      prompt: 'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
      sourceAudioText:
        'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.',
      sampleAnswer:
        'Transitioning to advanced language proficiency depends on producing formulaic word chunks automatically under time constraints rather than consciously piecing together individual words.',
      difficulty: 'hard',
      tags: ['dictogloss', 'cognitive-science', 'listening'],
    },
    {
      id: 'dg-conversation-brain-capital',
      skill: 'listening',
      type: 'listen-and-type',
      sourceAttribution: 'World Economic Forum / The Conversation',
      prompt: 'Investing in population brain health through restorative sleep, thermal resilience, and lifelong cognitive training yields cascading economic dividends by strengthening human adaptability alongside artificial intelligence.',
      sourceAudioText:
        'Investing in population brain health through restorative sleep, thermal resilience, and lifelong cognitive training yields cascading economic dividends by strengthening human adaptability alongside artificial intelligence.',
      sampleAnswer:
        'Safeguarding cognitive health and environmental resilience produces broad economic benefits by helping workers adapt effectively in an AI-driven economy.',
      difficulty: 'hard',
      tags: ['dictogloss', 'neuroscience', 'listening'],
    },
  ];
}

export class DETDatabase extends Dexie {
  settings!: Table<Settings, string>;
  questionBank!: Table<QuestionBankItem, string>;
  evalPrompts!: Table<EvalPrompt, string>;
  sessionTemplates!: Table<SessionTemplate, string>;
  sessionRuns!: Table<SessionRun, string>;

  constructor() {
    super('det-prep-app');
    this.version(1).stores({
      settings: 'id',
      questionBank: 'id, skill, type, difficulty, srs.nextReviewDate',
      evalPrompts: 'id, appliesToType',
      sessionTemplates: 'id, deletedAt',
      sessionRuns: 'id, templateId, status, startedAt',
    });
    this.on('populate', () => this.populateDefaults());
  }

  async populateDefaults(): Promise<void> {
    const now = new Date().toISOString();
    await this.settings.put({
      id: 'app-settings',
      geminiApiKey: '',
      sttProvider: 'local-whisper',
      localWhisperUrl: 'http://127.0.0.1:8000/transcribe',
      autoAdvanceDefault: true,
      instantFeedbackDefault: true,
      srsDefaults: {
        startEase: 2.5,
        startIntervalDays: 1,
      },
    });

    const readingEvalId = crypto.randomUUID();
    const brainDumpEvalId = crypto.randomUUID();
    const vocabEvalId = crypto.randomUUID();
    const speakingEvalId = crypto.randomUUID();
    const shadowingEvalId = crypto.randomUUID();
    const dictoglossEvalId = crypto.randomUUID();
    const mockEvalId = crypto.randomUUID();

    await this.evalPrompts.bulkPut([
      {
        id: readingEvalId,
        name: 'DET Interactive Reading & Cloze Evaluator (140-150)',
        appliesToType: 'interactive-reading',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: brainDumpEvalId,
        name: 'DET Brain-Dump & Outline Evaluator (140-150)',
        appliesToType: 'brain-dump',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: vocabEvalId,
        name: 'DET Collocation Chunk & Writing Evaluator (140-150)',
        appliesToType: 'vocab-writing',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
      {
        id: speakingEvalId,
        name: 'DET Timestamped Verbatim Speaking Evaluator (140-150)',
        appliesToType: 'speaking',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_SPEAKING_PROMPT,
      },
      {
        id: shadowingEvalId,
        name: 'SLA Shadowing Prosody Evaluator (140-150)',
        appliesToType: 'shadowing',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_SHADOWING_PROMPT,
      },
      {
        id: dictoglossEvalId,
        name: 'SLA Dictogloss Working-Memory Evaluator (140-150)',
        appliesToType: 'dictogloss',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_DICTOGLOSS_PROMPT,
      },
      {
        id: mockEvalId,
        name: 'DET Mock Test Evaluator (140-150)',
        appliesToType: 'mock-test',
        scoreScale: 'det-0-160',
        promptText: DEFAULT_WRITING_PROMPT,
      },
    ]);

    await this.questionBank.bulkPut(buildRichQuestionBank());

    await this.sessionTemplates.bulkPut([
      {
        id: 'tpl-reading-and-production',
        name: 'DET Interactive Reading & Production Suite (BBC / The Conversation)',
        description: 'Official 6-Step Interactive Reading + Read & Complete Cloze + Collocation Chunk Writing + 90s Verbatim Speaking.',
        blocks: [
          {
            id: crypto.randomUUID(),
            name: '1. Interactive Reading Suite (BBC / The Conversation)',
            type: 'interactive-reading',
            durationSec: 8 * 60,
            instructions: 'Complete all 6 official DET Interactive Reading steps (Complete the Sentences, Complete the Passage, Highlight the Answer, Identify the Idea, Title the Passage).',
            autoAdvance: false,
            evalPromptId: readingEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '2. Collocation Chunk Precision Writing (SRS)',
            type: 'vocab-writing',
            durationSec: 5 * 60,
            instructions: 'Write a cohesive C1/C2 academic paragraph incorporating all required multi-word collocation chunks.',
            autoAdvance: false,
            evalPromptId: vocabEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '3. Timed Verbatim Speaking & Noticing Loop',
            type: 'speaking',
            durationSec: 2 * 60,
            instructions: 'Speak for 90 seconds on the prompt. Review your timestamped pauses and immediately re-record to fix hesitations.',
            autoAdvance: false,
            evalPromptId: speakingEvalId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'tpl-sla-deliberate-practice',
        name: 'SLA Deliberate Practice Protocol (140-150 C1/C2)',
        description: 'Arguelles Shadowing -> Dictogloss Reconstruction -> Collocation Chunk Writing -> Timed Verbatim Speaking.',
        blocks: [
          {
            id: crypto.randomUUID(),
            name: '1. Motor-Auditory Shadowing (Arguelles Method)',
            type: 'shadowing',
            durationSec: 3 * 60,
            instructions: 'Listen to the native academic passage and speak simultaneously (lagging by 0.5s) to train rhythm, prosody, and automaticity.',
            autoAdvance: false,
            evalPromptId: shadowingEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '2. Dictogloss Working-Memory Reconstruction',
            type: 'dictogloss',
            durationSec: 4 * 60,
            instructions: 'Listen to the passage while taking 2-4 word fragment notes, then reconstruct the core meaning using complex subordination.',
            autoAdvance: false,
            evalPromptId: dictoglossEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '3. Collocation Chunk Precision Writing (SRS)',
            type: 'vocab-writing',
            durationSec: 5 * 60,
            instructions: 'Write a cohesive C1/C2 academic paragraph incorporating all required multi-word collocation chunks.',
            autoAdvance: false,
            evalPromptId: vocabEvalId,
          },
          {
            id: crypto.randomUUID(),
            name: '4. Timed Verbatim Speaking & Noticing Loop',
            type: 'speaking',
            durationSec: 2 * 60,
            instructions: 'Speak for 90 seconds on the prompt. Review your timestamped pauses and immediately re-record to fix hesitations.',
            autoAdvance: false,
            evalPromptId: speakingEvalId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ]);
  }
}

export const db = new DETDatabase();

export async function ensureDatabaseUpgraded(): Promise<void> {
  // 1. Seed all new BBC / The Conversation questions by deterministic ID without losing custom user questions
  const richItems = buildRichQuestionBank();
  const existingQuestions = await db.questionBank.toArray();
  const existingIds = new Set(existingQuestions.map((q) => q.id));
  const missingItems = richItems.filter((item) => !existingIds.has(item.id));
  if (missingItems.length > 0) {
    await db.questionBank.bulkPut(missingItems);
  }

  // 2. Ensure Interactive Reading eval prompt exists
  const prompts = await db.evalPrompts.toArray();
  let readingEvalId = prompts.find((p) => p.appliesToType === 'interactive-reading')?.id;
  if (!readingEvalId) {
    readingEvalId = crypto.randomUUID();
    await db.evalPrompts.put({
      id: readingEvalId,
      name: 'DET Interactive Reading & Cloze Evaluator (140-150)',
      appliesToType: 'interactive-reading',
      scoreScale: 'det-0-160',
      promptText: DEFAULT_WRITING_PROMPT,
    });
  }

  // 3. Ensure the new DET Interactive Reading & Production template exists
  const templates = await db.sessionTemplates.toArray();
  const hasReadingTemplate = templates.some((t) =>
    t.blocks.some((b) => b.type === 'interactive-reading')
  );
  if (!hasReadingTemplate) {
    const vocabEvalId = prompts.find((p) => p.appliesToType === 'vocab-writing')?.id ?? readingEvalId;
    const speakingEvalId = prompts.find((p) => p.appliesToType === 'speaking')?.id ?? readingEvalId;
    const now = new Date().toISOString();
    await db.sessionTemplates.put({
      id: 'tpl-reading-and-production',
      name: 'DET Interactive Reading & Production Suite (BBC / The Conversation)',
      description: 'Official 6-Step Interactive Reading + Read & Complete Cloze + Collocation Chunk Writing + 90s Verbatim Speaking.',
      blocks: [
        {
          id: crypto.randomUUID(),
          name: '1. Interactive Reading Suite (BBC / The Conversation)',
          type: 'interactive-reading',
          durationSec: 8 * 60,
          instructions: 'Complete all 6 official DET Interactive Reading steps (Complete the Sentences, Complete the Passage, Highlight the Answer, Identify the Idea, Title the Passage).',
          autoAdvance: false,
          evalPromptId: readingEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '2. Collocation Chunk Precision Writing (SRS)',
          type: 'vocab-writing',
          durationSec: 5 * 60,
          instructions: 'Write a cohesive C1/C2 academic paragraph incorporating all required multi-word collocation chunks.',
          autoAdvance: false,
          evalPromptId: vocabEvalId,
        },
        {
          id: crypto.randomUUID(),
          name: '3. Timed Verbatim Speaking & Noticing Loop',
          type: 'speaking',
          durationSec: 2 * 60,
          instructions: 'Speak for 90 seconds on the prompt. Review your timestamped pauses and immediately re-record to fix hesitations.',
          autoAdvance: false,
          evalPromptId: speakingEvalId,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }
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
console.log('\nInteractive Reading Suite & 30+ BBC / The Conversation Question Bank applied successfully!');