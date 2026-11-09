import { useState, useEffect } from 'react'
import { db } from '../../db/database'
import type { Settings, STTProvider as STTProviderType } from '../../types'

/**
 * SettingsPanel — Manages API keys, STT provider selection,
 * default durations, SRS defaults, and config import/export.
 *
 * API keys are stored in IndexedDB — NOT in .env files.
 */
export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showGeminiKey, setShowGeminiKey] = useState(false)
  const [showSttKey, setShowSttKey] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  // Load settings from DB
  useEffect(() => {
    const loadSettings = async () => {
      const s = await db.settings.get('app-settings')
      if (s) setSettings(s)
    }
    loadSettings()
  }, [])

  const handleSave = async () => {
    if (!settings) return
    setSaveStatus('saving')
    await db.settings.put(settings)
    setSaveStatus('saved')
    setTimeout(() => setSaveStatus('idle'), 2000)
  }

  const handleExportConfig = async () => {
    const templates = await db.sessionTemplates.toArray()
    const questions = await db.questionBank.toArray()
    const evalPrompts = await db.evalPrompts.toArray()
    const data = {
      exportedAt: new Date().toISOString(),
      version: 1,
      templates,
      questions,
      evalPrompts,
      settings: settings
        ? { ...settings, geminiApiKey: '[REDACTED]', sttApiKey: '[REDACTED]' }
        : null,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `det-prep-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportConfig = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        // Import templates
        if (data.templates?.length) {
          for (const t of data.templates) {
            await db.sessionTemplates.put(t)
          }
        }
        // Import questions
        if (data.questions?.length) {
          for (const q of data.questions) {
            await db.questionBank.put(q)
          }
        }
        // Import eval prompts
        if (data.evalPrompts?.length) {
          for (const ep of data.evalPrompts) {
            await db.evalPrompts.put(ep)
          }
        }
        alert(`Imported: ${data.templates?.length ?? 0} templates, ${data.questions?.length ?? 0} questions, ${data.evalPrompts?.length ?? 0} eval prompts`)
      } catch {
        alert('Failed to parse import file. Make sure it\'s a valid DET Prep config JSON.')
      }
    }
    input.click()
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-slate-400">Loading settings...</div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-900 mb-6">Settings</h2>

      <div className="space-y-6">
        {/* API Keys Section */}
        <section className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-4">🔑 API Keys</h3>
          <p className="text-sm text-slate-500 mb-4">
            Keys are stored locally in your browser's IndexedDB. They are never sent anywhere
            except to the respective API endpoints.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Gemini API Key
              </label>
              <div className="flex gap-2">
                <input
                  type={showGeminiKey ? 'text' : 'password'}
                  value={settings.geminiApiKey}
                  onChange={(e) =>
                    setSettings({ ...settings, geminiApiKey: e.target.value })
                  }
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="AIza..."
                />
                <button
                  onClick={() => setShowGeminiKey(!showGeminiKey)}
                  className="px-3 py-2 text-sm text-slate-500 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  {showGeminiKey ? '🙈' : '👁️'}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                STT Provider
              </label>
              <select
                value={settings.sttProvider}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    sttProvider: e.target.value as STTProviderType,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="whisper">OpenAI Whisper API (recommended)</option>
                <option value="web-speech-api">Web Speech API (free fallback)</option>
              </select>
            </div>

            {settings.sttProvider === 'whisper' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  OpenAI API Key (for Whisper)
                </label>
                <div className="flex gap-2">
                  <input
                    type={showSttKey ? 'text' : 'password'}
                    value={settings.sttApiKey ?? ''}
                    onChange={(e) =>
                      setSettings({ ...settings, sttApiKey: e.target.value || undefined })
                    }
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="sk-..."
                  />
                  <button
                    onClick={() => setShowSttKey(!showSttKey)}
                    className="px-3 py-2 text-sm text-slate-500 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    {showSttKey ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Defaults Section */}
        <section className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-4">⚙️ Defaults</h3>

          <div className="space-y-4">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={settings.autoAdvanceDefault}
                onChange={(e) =>
                  setSettings({ ...settings, autoAdvanceDefault: e.target.checked })
                }
                className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-slate-700">Auto-advance blocks</span>
                <p className="text-xs text-slate-500">
                  Automatically move to the next block when time expires
                </p>
              </div>
            </label>
          </div>
        </section>

        {/* SRS Defaults */}
        <section className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-4">🔄 Spaced Repetition Defaults</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Starting Ease Factor
              </label>
              <input
                type="number"
                step="0.1"
                min="1.3"
                max="4.0"
                value={settings.srsDefaults.startEase}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    srsDefaults: {
                      ...settings.srsDefaults,
                      startEase: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-slate-400 mt-1">Typical: 2.5 (SM-2 default)</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Starting Interval (days)
              </label>
              <input
                type="number"
                min="1"
                value={settings.srsDefaults.startIntervalDays}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    srsDefaults: {
                      ...settings.srsDefaults,
                      startIntervalDays: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
        </section>

        {/* Import / Export */}
        <section className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-4">📦 Import / Export</h3>
          <p className="text-sm text-slate-500 mb-4">
            Export your configuration as JSON for backup. API keys are redacted in exports.
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleExportConfig}
              className="px-4 py-2 text-sm font-medium border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              📤 Export Config
            </button>
            <button
              onClick={handleImportConfig}
              className="px-4 py-2 text-sm font-medium border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              📥 Import Config
            </button>
          </div>
        </section>

        {/* Save button */}
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            className="px-6 py-2.5 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? '✓ Saved' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}

