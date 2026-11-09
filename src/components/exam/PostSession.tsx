import { useState, useCallback } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useAppStore } from '../../stores/appStore'
import { db } from '../../db/database'
import { evaluateResponse } from '../../services/gemini'
import type { EvaluationResult } from '../../services/gemini'
import { formatTime } from '../../utils/helpers'
import type { BlockResponse } from '../../types'/**
 * PostSession — Shown after a session completes.
 *
 * Phases:
 * 1. Review all responses (editable text before evaluation)
 * 2. "Evaluate" action — sends each block through Gemini
 * 3. Feedback view — per-block AI scores + strengths/weaknesses
 */
export function PostSession() {
  const activeRun = useSessionStore((s) => s.activeRun)
  const setView = useAppStore((s) => s.setView)

  const [evaluating, setEvaluating] = useState(false)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [localResponses, setLocalResponses] = useState<Record<string, BlockResponse>>(
    activeRun?.responses ?? {}
  )

  const handleUpdateText = (blockId: string, text: string) => {
    setLocalResponses((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], textOrTranscript: text },
    }))
  }

  const handleEvaluate = useCallback(async () => {
    if (!activeRun) return
    setEvaluating(true)
    setEvalError(null)

    try {
      // Load settings for API key
      const settings = await db.settings.get('app-settings')
      if (!settings?.geminiApiKey) {
        setEvalError(
          'Gemini API key not set. Go to Config → Settings to add your key.'
        )
        setEvaluating(false)
        return
      }

      // Load eval prompts
      const evalPrompts = await db.evalPrompts.toArray()

      const updatedResponses = { ...localResponses }

      for (const block of activeRun.blockConfigs) {
        const response = localResponses[block.id]
        if (!response?.textOrTranscript && !response?.audioBlobRef) continue

        // Find the matching eval prompt
        const evalPrompt = evalPrompts.find((ep) => ep.appliesToType === block.type)
        if (!evalPrompt) continue

        const variables: Record<string, string> = {
          prompt: block.instructions,
          response: response.textOrTranscript ?? '',
          transcript: response.textOrTranscript ?? '',
          durationSec: String(response.timeSpentSec ?? 0),
        }

        try {
          const feedback: EvaluationResult = await evaluateResponse({
            apiKey: settings.geminiApiKey,
            evalPromptTemplate: evalPrompt.promptText,
            variables,
          })

          const overallScore =
            typeof feedback.criteria === 'object'
              ? Math.round(
                  Object.values(feedback.criteria as Record<string, number>)
                    .filter((v): v is number => typeof v === 'number')
                    .reduce((a, b) => a + b, 0) /
                    Math.max(1, Object.keys(feedback.criteria).length)
                )
              : feedback.subscore

          updatedResponses[block.id] = {
            ...response,
            aiFeedback: {
              subscores: feedback.criteria as Record<string, number>,
              criteria: {},
              strengths: feedback.strengths,
              weaknesses: feedback.weaknesses,
              suggestions: feedback.suggestions,
              note: feedback.note,
            },
            aiOverallScore: overallScore,
            aiSubscores: feedback.criteria as Record<string, number>,
          }
        } catch (blockErr) {
          console.error(`Failed to evaluate block ${block.name}:`, blockErr)
          // Continue with other blocks — don't fail the whole batch
        }
      }

      setLocalResponses(updatedResponses)

      // Persist evaluated responses
      await db.sessionRuns.update(activeRun.id, { responses: updatedResponses })
    } catch (err) {
      setEvalError(
        err instanceof Error ? err.message : 'Evaluation failed. Check your API key and try again.'
      )
    } finally {
      setEvaluating(false)
    }
  }, [activeRun, localResponses])

  if (!activeRun) return null

  const hasAnyFeedback = Object.values(localResponses).some((r) => r.aiFeedback)
  const totalTime = activeRun.overallElapsedSec

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-3xl">🎉</span>
          <h2 className="text-2xl font-bold text-slate-900">Session Complete!</h2>
        </div>
        <p className="text-slate-500">
          {activeRun.templateName} · {formatTime(totalTime)} ·{' '}
          {activeRun.blockConfigs.length} blocks
        </p>
      </div>

      {/* Evaluate CTA */}
      {!hasAnyFeedback && (
        <div className="mb-8 bg-primary-50 border border-primary-200 rounded-xl p-5">
          <h3 className="font-semibold text-primary-800 mb-2">🤖 AI Evaluation</h3>
          <p className="text-sm text-primary-700 mb-4">
            Send your responses to Gemini for scored feedback against the DET 0–160 scale.
            Review and edit your responses below before submitting.
          </p>
          {evalError && (
            <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              {evalError}
            </div>
          )}
          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="px-5 py-2.5 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {evaluating ? '⏳ Evaluating…' : '✨ Evaluate with AI'}
          </button>
        </div>
      )}

      {/* Per-block review */}
      <div className="space-y-6">
        {activeRun.blockConfigs.map((block, idx) => {
          const response = localResponses[block.id]
          const feedback = response?.aiFeedback
          const score = response?.aiOverallScore

          return (
            <div key={block.id} className="bg-white rounded-xl border border-slate-200">
              {/* Block header */}
              <div className="flex items-center gap-3 p-4 border-b border-slate-100">
                <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-600 text-xs flex items-center justify-center font-bold">
                  {idx + 1}
                </span>
                <div className="flex-1">
                  <h3 className="font-semibold text-slate-900">{block.name}</h3>
                  <p className="text-xs text-slate-400">{block.type}</p>
                </div>
                {score !== undefined && (
                  <div className="text-right">
                    <span className="text-2xl font-black text-primary-600">{score}</span>
                    <span className="text-xs text-slate-400 block">/160</span>
                  </div>
                )}
              </div>

              <div className="p-4 space-y-4">
                {/* Response text — editable before eval */}
                {!feedback && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">
                      Your Response
                      {!hasAnyFeedback && (
                        <span className="ml-1 text-slate-400">(editable before evaluation)</span>
                      )}
                    </label>
                    {hasAnyFeedback ? (
                      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap bg-slate-50 rounded-lg p-3">
                        {response?.textOrTranscript || <em className="text-slate-400">No response</em>}
                      </p>
                    ) : (
                      <textarea
                        value={response?.textOrTranscript ?? ''}
                        onChange={(e) => handleUpdateText(block.id, e.target.value)}
                        rows={4}
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 resize-y focus:outline-none focus:ring-2 focus:ring-primary-400"
                      />
                    )}
                  </div>
                )}

                {/* Audio playback */}
                {response?.audioBlobRef && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">
                      Audio Recording
                    </label>
                    <audio controls src={response.audioBlobRef} className="w-full" />
                  </div>
                )}

                {/* AI Feedback */}
                {feedback && (
                  <div className="space-y-3">
                    {/* Response text (read-only after eval) */}
                    <div>
                      <p className="text-xs font-medium text-slate-500 mb-1">Your Response</p>
                      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap bg-slate-50 rounded-lg p-3">
                        {response?.textOrTranscript || <em className="text-slate-400">No text response</em>}
                      </p>
                    </div>

                    {/* Subscores */}
                    {feedback.subscores && Object.keys(feedback.subscores).length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-2">Criteria Scores</p>
                        <div className="grid grid-cols-2 gap-2">
                          {Object.entries(feedback.subscores).map(([key, val]) => (
                            <div key={key} className="bg-slate-50 rounded-lg p-2.5">
                              <p className="text-xs text-slate-500 capitalize">{key.replace(/_/g, ' ')}</p>
                              <p className="text-lg font-bold text-primary-600">{val}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Strengths / Weaknesses / Suggestions */}
                    <div className="grid grid-cols-1 gap-3">
                      {feedback.strengths?.length > 0 && (
                        <FeedbackList title="✅ Strengths" items={feedback.strengths} color="green" />
                      )}
                      {feedback.weaknesses?.length > 0 && (
                        <FeedbackList title="⚠️ Weaknesses" items={feedback.weaknesses} color="amber" />
                      )}
                      {feedback.suggestions?.length > 0 && (
                        <FeedbackList title="💡 Suggestions" items={feedback.suggestions} color="blue" />
                      )}
                    </div>

                    {feedback.note && (
                      <p className="text-xs text-slate-400 italic">{feedback.note}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Re-evaluate option */}
      {hasAnyFeedback && (
        <div className="mt-6 flex justify-between items-center">
          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
          >
            {evaluating ? 'Evaluating…' : '↺ Re-evaluate with AI'}
          </button>
          <button
            onClick={() => setView('config')}
            className="px-5 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition-colors"
          >
            ← Back to Config
          </button>
        </div>
      )}

      {!hasAnyFeedback && (
        <div className="mt-6 flex justify-end">
          <button
            onClick={() => setView('config')}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Skip evaluation → Back to Config
          </button>
        </div>
      )}
    </div>
  )
}

// ── Helper: feedback list ────────────────────────────────────────────────────

function FeedbackList({
  title,
  items,
  color,
}: {
  title: string
  items: string[]
  color: 'green' | 'amber' | 'blue'
}) {
  const bgMap = { green: 'bg-green-50', amber: 'bg-amber-50', blue: 'bg-blue-50' }
  const textMap = { green: 'text-green-800', amber: 'text-amber-800', blue: 'text-blue-800' }
  const dotMap = { green: 'bg-green-400', amber: 'bg-amber-400', blue: 'bg-blue-400' }

  return (
    <div className={`${bgMap[color]} rounded-lg p-3`}>
      <p className={`text-xs font-semibold ${textMap[color]} mb-2`}>{title}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${dotMap[color]} flex-shrink-0`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
