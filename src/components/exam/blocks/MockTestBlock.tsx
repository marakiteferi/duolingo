import { useCallback, useEffect, useState } from 'react';
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
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

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
      const wc = val.trim() ? val.trim().split(/\s+/).length : 0;
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
                    {q.dayNumber ? `Day ${q.dayNumber}: ` : `#${idx + 1}: `}
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
                {activeQuestion?.dayNumber ? ` • Plan Day ${activeQuestion.dayNumber}` : ''}
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
