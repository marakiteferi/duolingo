import { useCallback } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import type { BlockConfig } from '../../../types'

/**
 * BrainDumpBlock — Free-form writing textarea.
 * Saves draft text on every keystroke via updateResponse.
 */
export function BrainDumpBlock({ block }: { block: BlockConfig }) {
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
    <div className="flex flex-col h-full">
      <textarea
        value={text}
        onChange={handleChange}
        placeholder="Start writing freely… don't stop, don't edit, just write."
        className="flex-1 w-full min-h-[400px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-primary-400 leading-relaxed placeholder:text-slate-300"
        spellCheck
        autoFocus
      />
      <div className="flex justify-end mt-2 text-xs text-slate-400">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </div>
    </div>
  )
}

