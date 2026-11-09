import { useEffect, useState } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useConfigStore } from '../../stores/configStore'
import { db } from '../../db/database'
import type { SessionTemplate, SessionRun } from '../../types'
import { formatTime } from '../../utils/helpers'

/**
 * PreSession — Shown before a session starts.
 * Lets the user pick a template, see the block breakdown,
 * do a mic check, and resume an interrupted session if one exists.
 */
export function PreSession() {
  const templates = useConfigStore((s) => s.templates)
  const startSession = useSessionStore((s) => s.startSession)
  const resumeSession = useSessionStore((s) => s.resumeSession)
  const selectedTemplateId = useSessionStore((s) => s.selectedTemplateId)
  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId)

  const [incompleteRun, setIncompleteRun] = useState<SessionRun | null>(null)
  const [micStatus, setMicStatus] = useState<'unchecked' | 'granted' | 'denied'>('unchecked')
  const [starting, setStarting] = useState(false)

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null

  // Check for interrupted sessions on mount
  useEffect(() => {
    const checkIncomplete = async () => {
      const inProgress = await db.sessionRuns
        .where('status')
        .equals('in-progress')
        .reverse()
        .sortBy('startedAt')
      if (inProgress.length > 0) setIncompleteRun(inProgress[0])
    }
    checkIncomplete()
  }, [])

  // Set default template if none selected
  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id)
    }
  }, [templates, selectedTemplateId, setSelectedTemplateId])

  const hasSpeakingBlock = selectedTemplate?.blocks.some((b) => b.type === 'speaking') ?? false

  const handleMicCheck = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      setMicStatus('granted')
    } catch {
      setMicStatus('denied')
    }
  }

  const handleStart = async () => {
    if (!selectedTemplate) return
    if (hasSpeakingBlock && micStatus !== 'granted') {
      const proceed = window.confirm(
        'Mic permission not granted. Speaking blocks require microphone access. Continue anyway?'
      )
      if (!proceed) return
    }
    setStarting(true)
    await startSession(selectedTemplate)
  }

  const handleResume = () => {
    if (!incompleteRun) return
    resumeSession(incompleteRun)
  }

  const handleStartFresh = () => {
    setIncompleteRun(null)
  }

  const totalSec = selectedTemplate?.blocks.reduce((s, b) => s + b.durationSec, 0) ?? 0

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">

      {/* Resume prompt */}
      {incompleteRun && (
        <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h3 className="font-semibold text-amber-800 mb-1">🔁 Incomplete Session Found</h3>
          <p className="text-sm text-amber-700 mb-4">
            You have an interrupted session from{' '}
            <strong>{new Date(incompleteRun.startedAt).toLocaleString()}</strong>.
            Resume exactly where you left off, or start fresh.
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleResume}
              className="px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 transition-colors"
            >
              ▶ Resume Session
            </button>
            <button
              onClick={handleStartFresh}
              className="px-4 py-2 text-sm text-amber-700 border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors"
            >
              Start Fresh
            </button>
          </div>
        </div>
      )}

      <h2 className="text-2xl font-bold text-slate-900 mb-2">Start a Practice Session</h2>
      <p className="text-slate-500 mb-8">Pick a template and get ready.</p>

      {/* Template picker */}
      <div className="mb-6">
        <label className="block text-sm font-semibold text-slate-700 mb-2">
          Session Template
        </label>
        {templates.length === 0 ? (
          <div className="text-sm text-slate-400 bg-slate-50 rounded-lg p-4 border border-slate-200">
            No templates found. Go to Config → Session Templates to create one.
          </div>
        ) : (
          <div className="grid gap-3">
            {templates.map((t) => {
              const dur = t.blocks.reduce((s, b) => s + b.durationSec, 0)
              return (
                <label
                  key={t.id}
                  className={`flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    selectedTemplateId === t.id
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-slate-200 bg-white hover:border-primary-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={selectedTemplateId === t.id}
                    onChange={() => setSelectedTemplateId(t.id)}
                    className="mt-0.5 text-primary-600 focus:ring-primary-500"
                  />
                  <div className="flex-1">
                    <p className="font-semibold text-slate-900">{t.name}</p>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {t.blocks.length} blocks · {formatTime(dur)} total
                    </p>
                    {/* Block breakdown bar */}
                    <div className="flex gap-1 mt-2">
                      {t.blocks.map((b) => (
                        <div
                          key={b.id}
                          className="h-1.5 rounded-full bg-primary-400 opacity-70"
                          style={{ flex: b.durationSec }}
                          title={`${b.name}: ${Math.ceil(b.durationSec / 60)}m`}
                        />
                      ))}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* Block sequence preview */}
      {selectedTemplate && (
        <div className="mb-6 bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">
            Block Sequence · {formatTime(totalSec)} total
          </h3>
          <div className="space-y-2">
            {selectedTemplate.blocks.map((b, i) => (
              <div key={b.id} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-xs flex items-center justify-center font-semibold flex-shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-slate-800">{b.name}</span>
                    <span className="ml-2 text-xs text-slate-400">{b.type}</span>
                  </div>
                  <span className="text-sm text-slate-500 font-mono">
                    {formatTime(b.durationSec)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mic check (only if speaking block present) */}
      {hasSpeakingBlock && (
        <div className="mb-6 bg-slate-50 rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">🎤 Mic Check</h3>
          <p className="text-xs text-slate-500 mb-3">
            This session includes speaking blocks. Grant microphone access before starting.
          </p>
          {micStatus === 'unchecked' && (
            <button
              onClick={handleMicCheck}
              className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-white transition-colors"
            >
              Check Microphone
            </button>
          )}
          {micStatus === 'granted' && (
            <span className="text-sm text-green-600 font-medium">✓ Microphone ready</span>
          )}
          {micStatus === 'denied' && (
            <span className="text-sm text-red-600">
              ✗ Permission denied — speaking blocks will not record audio.
            </span>
          )}
        </div>
      )}

      {/* Start button */}
      <button
        onClick={handleStart}
        disabled={!selectedTemplate || starting}
        className="w-full py-4 bg-primary-600 text-white text-base font-bold rounded-xl hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? 'Starting…' : '🎯 Start Session'}
      </button>
    </div>
  )
}

