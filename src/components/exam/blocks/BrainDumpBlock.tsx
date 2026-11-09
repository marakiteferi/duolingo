import { useCallback } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import type { BlockConfig } from '../../../types';

export function BrainDumpBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, { textOrTranscript: e.target.value });
    },
    [block.id, updateResponse]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  return (
    <div className="flex flex-col h-full space-y-3">
      {communicativePressure && (
        <div className="text-xs font-bold bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded-lg">
          Strict Communicative Pressure Mode Active: Backspace and Delete are disabled. Keep producing forward!
        </div>
      )}
      <textarea
        value={text}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        placeholder="Start writing freely — don't stop, don't self-censor, just produce."
        className="flex-1 w-full min-h-[360px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed"
        spellCheck
        autoFocus
      />
      <div className="flex justify-end text-xs text-slate-400">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </div>
    </div>
  );
}
