import { useCallback, useEffect, useState } from 'react';
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
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

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
