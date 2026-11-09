import { useCallback } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import type { BlockConfig } from '../../../types'

/**
 * VocabWritingBlock — Prompt list + textarea with live word count.
 * Uses the questionSetId from the block to load relevant prompts.
 * For now displays a general writing prompt; full SRS integration in step 7.
 */
export function VocabWritingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses)
  const updateResponse = useSessionStore((s) => s.updateResponse)

  const response = draftResponses[block.id]
  const text = response?.textOrTranscript ?? ''
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, { textOrTranscript: e.target.value })
    },
    [block.id, updateResponse]
  )

  return (
    <div className="space-y-4">
      {/* Prompt area */}
      <div className="bg-accent-50 border border-accent-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-accent-600 uppercase tracking-wide mb-2">
          Writing Prompt
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">
          {block.instructions || 'Write using the vocabulary words you have been studying. Use each word naturally in context.'}
        </p>
      </div>

      {/* Writing area */}
      <div>
        <textarea
          value={text}
          onChange={handleChange}
          placeholder="Write your response here…"
          className="w-full min-h-[320px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-accent-400 focus:border-accent-400 leading-relaxed placeholder:text-slate-300"
          spellCheck
          autoFocus
        />
        <div className="flex justify-between mt-1.5 text-xs text-slate-400">
          <span>Write at least 100 words for a full DET-style response</span>
          <span className={wordCount >= 100 ? 'text-green-500' : ''}>
            {wordCount} {wordCount === 1 ? 'word' : 'words'}
            {wordCount >= 100 ? ' ✓' : ` / 100`}
          </span>
        </div>
      </div>
    </div>
  )
}

