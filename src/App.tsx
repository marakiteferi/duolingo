import { useAppStore } from './stores/appStore'
import { ConfigPage } from './pages/ConfigPage'
import { ExamPage } from './pages/ExamPage'

/**
 * Root application component.
 * Uses a simple view switch (no React Router) — just a top-level
 * enum toggling between the Config admin page and the Exam runner.
 */
export default function App() {
  const currentView = useAppStore((s) => s.currentView)

  return (
    <div className="min-h-screen bg-slate-50">
      {currentView === 'config' ? <ConfigPage /> : <ExamPage />}
    </div>
  )
}
