import { useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { useSessionStore } from '../stores/sessionStore'
import { useConfigStore } from '../stores/configStore'
import { PreSession } from '../components/exam/PreSession'
import { SessionRunner } from '../components/exam/SessionRunner'
import { PostSession } from '../components/exam/PostSession'

/**
 * Exam Page — The timed exam runner.
 *
 * Three phases:
 * 1. Pre-session: Select template, mic check, resume prompt
 * 2. In-session: Timer + block input components
 * 3. Post-session: Review responses, trigger AI evaluation
 */
export function ExamPage() {
  const setView = useAppStore((s) => s.setView)
  const activeRun = useSessionStore((s) => s.activeRun)
  const loadTemplates = useConfigStore((s) => s.loadTemplates)

  // Load templates for the template picker
  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  // Determine which phase we're in
  const phase = !activeRun
    ? 'pre'
    : activeRun.status === 'completed'
      ? 'post'
      : 'in-session'

  const handleBackToConfig = useCallback(() => {
    setView('config')
  }, [setView])

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar — only shown in pre/post, hidden during session for max focus */}
      {phase !== 'in-session' && (
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBackToConfig}
              className="text-slate-500 hover:text-slate-700 transition-colors"
              title="Back to Config"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-lg font-bold text-slate-900">DET Prep</h1>
            <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">Exam</span>
          </div>
          <button
            onClick={handleBackToConfig}
            className="text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            ← Back to Config
          </button>
        </header>
      )}

      {/* Phase-specific content */}
      <div className="view-enter">
        {phase === 'pre' && <PreSession />}
        {phase === 'in-session' && <SessionRunner />}
        {phase === 'post' && <PostSession />}
      </div>
    </div>
  )
}

