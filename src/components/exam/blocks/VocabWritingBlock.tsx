import { useCallback, useEffect, useState, useMemo } from 'react';
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
  return `${q.prompt}\nRequired Collocation Chunks: ${chunks.map((c) => `"${c}"`).join(', ')}`;
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
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

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
      const wc = val.trim() ? val.trim().split(/\s+/).length : 0;
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
    setGradedMessage(`✓ Marked Done & SRS Updated (${label}): Next review in ${updatedSrs.intervalDays}d`);
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
                    {q.dayNumber ? `Day ${q.dayNumber}: ` : `Set #${idx + 1}: `}
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
              className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                usedChunksCount === activeChunks.length
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-accent-800 border border-accent-300'
              }`}
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
