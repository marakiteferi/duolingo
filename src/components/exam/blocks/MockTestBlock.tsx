import { useCallback } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import type { BlockConfig } from '../../../types'

/**
 * MockTestBlock — DET-style timed question flow.
 * Displays the prompt and collects a written response.
 * Full multi-question sub-timer flow is a later iteration.
 */
export function MockTestBlock({ block }: { block: BlockConfig }) {
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
      {/* DET-style header */}
      <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 uppercase tracking-wide">
          Mock Test
        </span>
        <span>Simulate real exam conditions — write without pausing</span>
      </div>

      {/* Prompt card */}
      <div className="bg-white border-2 border-slate-200 rounded-xl p-5">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
          Task
        </p>
        <p className="text-base text-slate-800 leading-relaxed">
          {block.instructions || 'Complete the DET-style task below. Write a full, organized response.'}
        </p>
      </div>

      {/* Response area */}
      <textarea
        value={text}
        onChange={handleChange}
        placeholder="Write your response here…"
        className="w-full min-h-[300px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-primary-400 leading-relaxed placeholder:text-slate-300"
        spellCheck
        autoFocus
      />
      <div className="flex justify-end text-xs text-slate-400">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </div>
    </div>
  )
}

