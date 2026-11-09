import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConfigStore } from '../stores/configStore'
import { TemplateEditor } from '../components/config/TemplateEditor'
import { QuestionBankEditor } from '../components/config/QuestionBankEditor'
import { EvalPromptEditor } from '../components/config/EvalPromptEditor'
import { SettingsPanel } from '../components/config/SettingsPanel'

/**
 * Config Page — Admin panel for managing session templates,
 * question banks, evaluation prompts, and app settings.
 *
 * Layout: Left sidebar nav + right content panel.
 */
export function ConfigPage() {
  const configSection = useAppStore((s) => s.configSection)
  const setConfigSection = useAppStore((s) => s.setConfigSection)
  const setView = useAppStore((s) => s.setView)
  const loadTemplates = useConfigStore((s) => s.loadTemplates)
  const loadQuestions = useConfigStore((s) => s.loadQuestions)
  const loadEvalPrompts = useConfigStore((s) => s.loadEvalPrompts)

  // Load all data on mount
  useEffect(() => {
    loadTemplates()
    loadQuestions()
    loadEvalPrompts()
  }, [loadTemplates, loadQuestions, loadEvalPrompts])

  const navItems = [
    { key: 'templates' as const, label: 'Session Templates', icon: '📋' },
    { key: 'questions' as const, label: 'Question Bank', icon: '❓' },
    { key: 'eval-prompts' as const, label: 'Eval Prompts', icon: '🤖' },
    { key: 'settings' as const, label: 'Settings', icon: '⚙️' },
  ]

  return (
    <div className="flex h-screen">
      {/* Left Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        {/* App Header */}
        <div className="p-4 border-b border-slate-200">
          <h1 className="text-lg font-bold text-slate-900">DET Prep</h1>
          <p className="text-xs text-slate-500 mt-0.5">Configuration</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setConfigSection(item.key)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                configSection === item.key
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Switch to Exam button */}
        <div className="p-3 border-t border-slate-200">
          <button
            onClick={() => setView('exam')}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-lg text-sm font-semibold hover:bg-primary-700 transition-colors"
          >
            <span>🎯</span>
            Start Exam Session
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto bg-slate-50">
        <div className="max-w-4xl mx-auto p-6 view-enter">
          {configSection === 'templates' && <TemplateEditor />}
          {configSection === 'questions' && <QuestionBankEditor />}
          {configSection === 'eval-prompts' && <EvalPromptEditor />}
          {configSection === 'settings' && <SettingsPanel />}
        </div>
      </main>
    </div>
  )
}

