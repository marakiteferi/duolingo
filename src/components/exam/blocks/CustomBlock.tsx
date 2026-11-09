import { useCallback } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import type { BlockConfig } from '../../../types'

/**
 * CustomBlock — Freeform block with no specific structure.
 * Acts as an escape hatch for user-defined block types.
 */
export function CustomBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses)
  const updateResponse = useSessionStore((s) => s.updateResponse)

  const response = draftResponses[block.id]
  const text = response?.textOrTranscript ?? ''

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, { textOrTranscript: e.target.value })
    },
    [block.id, updateResponse]
  )

  return (
    <div className="space-y-4">
      {block.instructions && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
          <p className="text-sm text-slate-700 leading-relaxed">{block.instructions}</p>
        </div>
      )}
      <textarea
        value={text}
        onChange={handleChange}
        placeholder="Notes, responses, or anything for this block…"
        className="w-full min-h-[380px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed placeholder:text-slate-300"
        spellCheck
        autoFocus
      />
    </div>
  )
}

