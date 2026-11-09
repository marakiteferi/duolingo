import { useCallback, useEffect, useState } from 'react';
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
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

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
        promptSnapshot: `${promptText} (Required Chunks: ${targetChunks.join('; ')})`,
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
    setGradedMessage(`SRS Updated (${label}): Next review in ${updatedSrs.intervalDays} day(s)`);
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
                className={`text-xs font-semibold px-3 py-1 rounded-full border transition-all ${
                  used
                    ? 'bg-green-100 text-green-800 border-green-300'
                    : 'bg-white text-slate-700 border-accent-200'
                }`}
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
