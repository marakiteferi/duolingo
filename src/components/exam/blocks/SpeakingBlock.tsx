import { useState, useRef, useCallback, useEffect } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import { AudioRecorderService } from '../../../services/audioRecorder'
import type { BlockConfig } from '../../../types'

/**
 * SpeakingBlock — Audio recorder with waveform visualizer.
 * Records via MediaRecorder (webm/opus primary, mp4 fallback).
 * Stores the blob reference and transcript placeholder in draftResponses.
 */
export function SpeakingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses)
  const updateResponse = useSessionStore((s) => s.updateResponse)

  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null)
  const [levels, setLevels] = useState<number[]>(new Array(32).fill(0))

  const recorderRef = useRef<AudioRecorderService | null>(null)
  const animFrameRef = useRef<number>(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const response = draftResponses[block.id]

  // Animate waveform bars using AnalyserNode
  const animateWaveform = useCallback(() => {
    const recorder = recorderRef.current
    const analyser = recorder?.getAnalyser()
    if (!analyser) return

    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(data)

    // Sample 32 evenly spaced buckets for the bar display
    const buckets = 32
    const step = Math.floor(data.length / buckets)
    const newLevels = Array.from({ length: buckets }, (_, i) =>
      Math.round((data[i * step] / 255) * 100)
    )
    setLevels(newLevels)
    animFrameRef.current = requestAnimationFrame(animateWaveform)
  }, [])

  const handleStart = useCallback(async () => {
    setError(null)
    try {
      const recorder = new AudioRecorderService()
      const hasPermission = await recorder.requestPermission()
      if (!hasPermission) {
        setError('Microphone permission denied. Please allow mic access and try again.')
        return
      }
      await recorder.start()
      recorderRef.current = recorder
      setRecordingState('recording')
      animateWaveform()
    } catch (e) {
      setError(`Could not start recording: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  }, [animateWaveform])

  const handleStop = useCallback(async () => {
    cancelAnimationFrame(animFrameRef.current)
    setLevels(new Array(32).fill(0))

    const recorder = recorderRef.current
    if (!recorder) return

    try {
      const blob = await recorder.stop()
      const url = URL.createObjectURL(blob)
      setAudioBlobUrl(url)
      setRecordingState('done')

      // Store blob reference in session response
      updateResponse(block.id, {
        audioBlobRef: url,
        textOrTranscript: '[Audio recorded — transcription pending evaluation]',
      })
    } catch (e) {
      setError(`Recording failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
      setRecordingState('idle')
    }
  }, [block.id, updateResponse])

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl)
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [audioBlobUrl])

  const handleRerecord = () => {
    if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl)
    setAudioBlobUrl(null)
    setRecordingState('idle')
    updateResponse(block.id, { audioBlobRef: undefined, textOrTranscript: '' })
  }

  return (
    <div className="space-y-6">
      {/* Prompt */}
      <div className="bg-primary-50 border border-primary-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-primary-600 uppercase tracking-wide mb-2">
          Speaking Prompt
        </p>
        <p className="text-base text-slate-800 leading-relaxed">
          {block.instructions || 'Speak clearly and naturally about the topic. Aim for 60–90 seconds.'}
        </p>
      </div>

      {/* Waveform visualizer */}
      {recordingState === 'recording' && (
        <div className="bg-slate-900 rounded-xl p-4">
          <div className="flex items-end justify-center gap-0.5 h-16">
            {levels.map((level, i) => (
              <div
                key={i}
                className="w-2 rounded-sm bg-primary-400 transition-all duration-75"
                style={{ height: `${Math.max(4, level)}%` }}
              />
            ))}
          </div>
          <p className="text-center text-xs text-slate-400 mt-2">Recording…</p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col items-center gap-4">
        {recordingState === 'idle' && !response?.audioBlobRef && (
          <button
            onClick={handleStart}
            className="w-20 h-20 rounded-full bg-red-500 hover:bg-red-600 text-white text-3xl flex items-center justify-center shadow-lg transition-all hover:scale-105"
            title="Start recording"
          >
            🎤
          </button>
        )}

        {recordingState === 'recording' && (
          <button
            onClick={handleStop}
            className="w-20 h-20 rounded-full bg-red-600 text-white text-2xl flex items-center justify-center shadow-lg animate-pulse"
            title="Stop recording"
          >
            ⏹
          </button>
        )}

        {recordingState === 'done' && audioBlobUrl && (
          <div className="w-full space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
              <p className="text-sm text-green-700 font-medium mb-3">✓ Recording captured</p>
              <audio controls src={audioBlobUrl} className="w-full" />
            </div>
            <button
              onClick={handleRerecord}
              className="w-full py-2 text-sm text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              🔄 Re-record
            </button>
          </div>
        )}

        {recordingState === 'idle' && response?.audioBlobRef && (
          <div className="w-full space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
              <p className="text-sm text-green-700 font-medium">✓ Audio saved</p>
            </div>
            <button
              onClick={handleRerecord}
              className="w-full py-2 text-sm text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              🔄 Re-record
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  )
}

