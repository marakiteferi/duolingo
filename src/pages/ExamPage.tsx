import { useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { useSessionStore } from '../stores/sessionStore'
import { useConfigStore } from '../stores/configStore'
import { PreSession } from '../components/exam/PreSession'
import { SessionRunner } from '../components/exam/SessionRunner'
import { PostSession } from '../components/exam/PostSession'
import { WhisperLiveIndicator } from '../components/common/WhisperLiveIndicator'

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
  const clearActiveRun = useSessionStore((s) => s.clearActiveRun)
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
    if (activeRun?.status === 'completed' || activeRun?.status === 'abandoned') {
      clearActiveRun()
    }
    setView('config')
  }, [activeRun, clearActiveRun, setView])

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top bar — shown in pre/post for easy navigation */}
      {phase !== 'in-session' && (
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBackToConfig}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
              title="Back to Config Dashboard"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              ← Back to Dashboard
            </button>
            <span className="w-px h-4 bg-slate-200" />
            <h1 className="text-base font-bold text-slate-900">DET Practice Runner</h1>
            <span className="text-xs text-primary-700 bg-primary-50 border border-primary-200 px-2 py-0.5 rounded font-semibold uppercase tracking-wider">
              {phase === 'pre' ? 'Setup' : 'Review'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <WhisperLiveIndicator compact />
            {phase === 'post' && (
              <button
                type="button"
                onClick={() => clearActiveRun()}
                className="text-xs font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
              >
                + New Practice Session
              </button>
            )}
            <button
              onClick={handleBackToConfig}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors"
            >
              Settings & History →
            </button>
          </div>
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

