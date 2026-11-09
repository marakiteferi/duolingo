import { useCallback, useEffect, useState, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { getAdaptiveQuestions } from '../../../utils/adaptive';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';
import type { BlockConfig, QuestionBankItem, DETQuestionType, DETSkill } from '../../../types';

const QUESTION_TYPE_LABELS: { value: DETQuestionType | 'adaptive'; label: string }[] = [
  { value: 'adaptive', label: '⚡ Adaptive (Targets Weakest Skill)' },
  { value: 'interactive-writing', label: '✍️ Interactive Writing' },
  { value: 'write-about-photo', label: '🖼️ Write About Photo' },
  { value: 'listen-and-type', label: '🎧 Listen & Type' },
  { value: 'read-aloud', label: '📖 Read Aloud' },
  { value: 'interactive-speaking', label: '🗣️ Interactive Speaking' },
  { value: 'speaking-sample', label: '🎤 Speaking Sample' },
];

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function MockTestBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const activeRun = useSessionStore((s) => s.activeRun);

  const [selectedType, setSelectedType] = useState<DETQuestionType | 'adaptive'>(
    block.preferredQuestionType ??
      (activeRun?.preferredQuestionType === 'all' ? 'adaptive' : activeRun?.preferredQuestionType) ??
      'adaptive'
  );
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [weakestSkill, setWeakestSkill] = useState<DETSkill | null>(null);

  // Audio recording state for speaking mock test questions
  const [inputMode, setInputMode] = useState<'speak' | 'type'>('type');
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevels, setAudioLevels] = useState<number[]>(new Array(24).fill(0));
  const [audioError, setAudioError] = useState<string | null>(null);
  const [transcribeProgress, setTranscribeProgress] = useState(0);
  const [transcribeStage, setTranscribeStage] = useState('');

  // Audio playback state for listen-and-type questions
  const [listenPlaysLeft, setListenPlaysLeft] = useState(3);
  const [showListenText, setShowListenText] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  const recorderRef = useRef<AudioRecorderService | null>(null);
  const animFrameRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];
  const text = response?.textOrTranscript ?? '';
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  useEffect(() => {
    getAdaptiveQuestions({
      questionType: selectedType,
      limit: 12,
    }).then(({ selected, weakestSkill: ws }) => {
      setQuestions(selected);
      setWeakestSkill(ws);
      setCurrentIndex(0);
    });
  }, [selectedType]);

  const activeQuestion = questions[currentIndex] ?? null;
  const isSpeakingType =
    activeQuestion?.skill === 'speaking' ||
    ['speaking-sample', 'interactive-speaking', 'read-aloud'].includes(
      activeQuestion?.type ?? (selectedType === 'adaptive' ? '' : selectedType)
    );
  const isListenType =
    activeQuestion?.type === 'listen-and-type' || selectedType === 'listen-and-type';

  // Automatically adapt input mode when question type changes
  useEffect(() => {
    if (isSpeakingType) {
      setInputMode('speak');
    } else {
      setInputMode('type');
    }
    setListenPlaysLeft(3);
    setShowListenText(!isListenType);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsPlayingAudio(false);
    }
  }, [isSpeakingType, isListenType, currentIndex]);

  const activePrompt =
    activeQuestion?.prompt ||
    block.instructions ||
    'Complete the DET-style task below under strict exam conditions.';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateResponse(block.id, {
        textOrTranscript: e.target.value,
        promptSnapshot: activePrompt,
        questionId: activeQuestion?.id,
        questionType: activeQuestion?.type ?? selectedType,
      });
    },
    [activePrompt, activeQuestion?.id, activeQuestion?.type, block.id, selectedType, updateResponse]
  );

  // Audio Waveform Visualizer
  const animateWaveform = useCallback(() => {
    const recorder = recorderRef.current;
    const analyser = recorder?.getAnalyser();
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const buckets = 24;
    const step = Math.floor(data.length / buckets);
    const newLevels = Array.from({ length: buckets }, (_, i) =>
      Math.round((data[i * step] / 255) * 100)
    );
    setAudioLevels(newLevels);
    animFrameRef.current = requestAnimationFrame(animateWaveform);
  }, []);

  // Transcribe recorded audio with local Faster-Whisper
  const transcribeBlob = useCallback(
    async (blob: Blob, durationSec: number) => {
      setRecordingState('transcribing');
      setTranscribeProgress(15);
      setTranscribeStage('Connecting to Whisper neural STT...');
      setAudioError(null);

      const progressInterval = setInterval(() => {
        setTranscribeProgress((prev) => {
          if (prev < 40) {
            setTranscribeStage('Connecting to Faster-Whisper GPU server...');
            return prev + 6;
          }
          if (prev < 75) {
            setTranscribeStage('Running beam search & verbatim speech recognition...');
            return prev + 7;
          }
          if (prev < 90) {
            setTranscribeStage('Detecting pauses and verbatim hesitations...');
            return prev + 3;
          }
          return prev;
        });
      }, 200);

      try {
        const dataUrl = await blobToDataUrl(blob);
        const settings = await db.settings.get('app-settings');
        const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
          apiKey: settings?.sttApiKey,
          localWhisperUrl: settings?.localWhisperUrl || settings?.localSttEndpoint,
        });

        const verbatimText = await stt.transcribe(blob, 'en');

        clearInterval(progressInterval);
        setTranscribeProgress(95);
        setTranscribeStage('Calculating speech rate & fluency metrics...');

        const stats = analyzeSpeechTranscript(verbatimText, Math.max(5, durationSec));

        updateResponse(block.id, {
          audioBlobRef: dataUrl,
          textOrTranscript: verbatimText || '[No speech detected in recording]',
          promptSnapshot: activePrompt,
          questionId: activeQuestion?.id,
          questionType: activeQuestion?.type ?? selectedType,
          fillerCount: stats.fillerCount,
          wpm: stats.wpm,
          timeSpentSec: Math.round(durationSec),
        });

        setTranscribeProgress(100);
        setTranscribeStage('Transcription complete!');
        setTimeout(() => setRecordingState('done'), 300);
      } catch (err) {
        clearInterval(progressInterval);
        const msg = err instanceof Error ? err.message : 'Transcription failed';
        setAudioError(msg);
        const fallbackUrl = await blobToDataUrl(blob).catch(() => '');
        updateResponse(block.id, {
          audioBlobRef: fallbackUrl,
          promptSnapshot: activePrompt,
          questionId: activeQuestion?.id,
          questionType: activeQuestion?.type ?? selectedType,
        });
        setRecordingState('done');
      }
    },
    [activePrompt, activeQuestion?.id, activeQuestion?.type, block.id, selectedType, updateResponse]
  );

  const handleStartRecord = async () => {
    try {
      setAudioError(null);
      const recorder = new AudioRecorderService();
      await recorder.requestPermission();
      recorderRef.current = recorder;

      await recorder.start();
      setRecordingState('recording');
      setRecordingSeconds(0);
      recordDurationRef.current = 0;

      recTimerRef.current = setInterval(() => {
        setRecordingSeconds((s) => {
          recordDurationRef.current = s + 1;
          return s + 1;
        });
      }, 1000);

      animateWaveform();
    } catch {
      setAudioError('Microphone permission denied or not found. Check browser permissions.');
      setRecordingState('idle');
    }
  };

  const handleStopRecord = async () => {
    cancelAnimationFrame(animFrameRef.current);
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder) return;

    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      await transcribeBlob(blob, recordDurationRef.current);
    } catch {
      setAudioError('Failed to capture audio recording.');
      setRecordingState('idle');
    }
  };

  // Play audio for Listen and Type using native SpeechSynthesis
  const handlePlayListeningAudio = () => {
    if (!('speechSynthesis' in window)) {
      alert('Speech synthesis is not supported in this browser.');
      return;
    }
    if (listenPlaysLeft <= 0) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(activePrompt);
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    utterance.onstart = () => setIsPlayingAudio(true);
    utterance.onend = () => setIsPlayingAudio(false);
    utterance.onerror = () => setIsPlayingAudio(false);
    window.speechSynthesis.speak(utterance);
    setListenPlaysLeft((p) => Math.max(0, p - 1));
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* Question Type Switcher & Adaptive Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">Question Type:</label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as DETQuestionType | 'adaptive')}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
          >
            {QUESTION_TYPE_LABELS.map((qt) => (
              <option key={qt.value} value={qt.value}>
                {qt.label}
              </option>
            ))}
          </select>
          {weakestSkill && (
            <span className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full font-medium">
              Adaptive Focus: {weakestSkill}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Mode Switcher for Speaking Tasks */}
          {isSpeakingType && (
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-xs font-semibold">
              <button
                type="button"
                onClick={() => setInputMode('speak')}
                className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                  inputMode === 'speak' ? 'bg-white text-primary-700 shadow-2xs' : 'text-slate-600'
                }`}
              >
                🎤 Voice Mode
              </button>
              <button
                type="button"
                onClick={() => setInputMode('type')}
                className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                  inputMode === 'type' ? 'bg-white text-primary-700 shadow-2xs' : 'text-slate-600'
                }`}
              >
                ⌨️ Type Mode
              </button>
            </div>
          )}

          {questions.length > 1 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCurrentIndex((i) => (i - 1 + questions.length) % questions.length)}
                className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
              >
                ← Prev
              </button>
              <span className="text-xs text-slate-500 font-mono">
                {currentIndex + 1} / {questions.length}
              </span>
              <button
                type="button"
                onClick={() => setCurrentIndex((i) => (i + 1) % questions.length)}
                className="px-2.5 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Prompt Card */}
      <div className="bg-white border-2 border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 px-2.5 py-0.5 rounded uppercase tracking-wide">
            {activeQuestion?.type ?? 'mock-test'} • {activeQuestion?.difficulty ?? 'hard'}
          </span>
          <div className="flex items-center gap-2">
            {isSpeakingType && <WhisperLiveIndicator compact />}
            <span className="text-xs text-slate-400">DET 140–150 Simulation</span>
          </div>
        </div>

        {/* Listen and Type Interactive Audio Player */}
        {isListenType ? (
          <div className="bg-sky-50 border border-sky-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-sky-800">
                  🎧 Listen & Type Task
                </p>
                <p className="text-xs text-sky-700 mt-0.5">
                  Type the exact sentence you hear. You may play the audio up to 3 times.
                </p>
              </div>
              <button
                type="button"
                onClick={handlePlayListeningAudio}
                disabled={listenPlaysLeft <= 0 || isPlayingAudio}
                className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer shadow-2xs"
              >
                <span>{isPlayingAudio ? '🔊 Playing...' : '▶ Play Audio'}</span>
                <span className="bg-sky-800 px-1.5 py-0.5 rounded text-[10px]">
                  {listenPlaysLeft} left
                </span>
              </button>
            </div>

            {/* Optional Reveal Text for post-practice verification */}
            <div className="pt-2 border-t border-sky-200/60 flex items-center justify-between">
              <span className="text-[11px] text-sky-700">Prompt text hidden for realistic listening:</span>
              <button
                type="button"
                onClick={() => setShowListenText((v) => !v)}
                className="text-xs font-semibold text-sky-800 hover:underline cursor-pointer"
              >
                {showListenText ? 'Hide Prompt' : '👁️ Reveal Prompt Text'}
              </button>
            </div>

            {showListenText && (
              <p className="p-3 bg-white/90 rounded-lg text-sm text-slate-800 font-medium border border-sky-200">
                "{activePrompt}"
              </p>
            )}
          </div>
        ) : (
          <p className="text-base text-slate-800 leading-relaxed font-medium">{activePrompt}</p>
        )}
      </div>

      {/* Voice Recording Interface for Speaking Questions */}
      {isSpeakingType && inputMode === 'speak' ? (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs">
          {/* Waveform Visualization */}
          {recordingState === 'recording' && (
            <div className="bg-slate-900 rounded-xl p-5 shadow-inner">
              <div className="flex items-end justify-center gap-1 h-16">
                {audioLevels.map((lvl, i) => (
                  <div
                    key={i}
                    className="w-2 rounded-sm bg-primary-400 transition-all duration-75"
                    style={{ height: `${Math.max(8, lvl)}%` }}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-xs text-slate-300 mt-3 pt-2 border-t border-slate-800">
                <span className="flex items-center gap-2 text-red-400 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                  Recording Verbatim Audio...
                </span>
                <span className="font-mono text-sm text-white font-bold">{recordingSeconds}s</span>
              </div>
            </div>
          )}

          {/* Transcription Progress Bar */}
          {recordingState === 'transcribing' && (
            <div className="bg-primary-50 border border-primary-200 rounded-xl p-5 space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-primary-900">{transcribeStage}</span>
                <span className="font-mono font-bold text-primary-700">{transcribeProgress}%</span>
              </div>
              <div className="w-full bg-primary-100 h-2.5 rounded-full overflow-hidden">
                <div
                  className="bg-primary-600 h-full rounded-full transition-all duration-200"
                  style={{ width: `${transcribeProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Message */}
          {audioError && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              {audioError}
            </div>
          )}

          {/* Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {recordingState === 'idle' && (
              <button
                type="button"
                onClick={handleStartRecord}
                className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer shadow-xs"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                Record Speech
              </button>
            )}

            {recordingState === 'recording' && (
              <button
                type="button"
                onClick={handleStopRecord}
                className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold rounded-xl transition-colors cursor-pointer"
              >
                ■ Finish & Transcribe
              </button>
            )}

            {recordingState === 'done' && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleStartRecord}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors cursor-pointer"
                >
                  ↻ Re-record Audio
                </button>
                <span className="text-xs text-green-700 font-semibold">✓ Recorded & Transcribed</span>
              </div>
            )}

            {response?.audioBlobRef && (
              <audio controls src={response.audioBlobRef} className="h-9 max-w-xs" />
            )}
          </div>

          {/* Transcript Preview & Editor */}
          {text && (
            <div className="pt-3 border-t border-slate-100 space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600">
                Verbatim Transcript (Editable):
              </label>
              <textarea
                value={text}
                onChange={handleChange}
                rows={3}
                className="w-full p-3 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
              />
              <div className="flex justify-between text-xs text-slate-500">
                <span>{response?.wpm ? `${response.wpm} WPM` : ''}</span>
                <span className="font-mono">{wordCount} words</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Response Textarea for Writing & Typing Tasks */
        <div>
          <textarea
            value={text}
            onChange={handleChange}
            placeholder={
              isListenType
                ? 'Type the exact words you hear in the audio...'
                : 'Type your full DET response here...'
            }
            className="w-full min-h-[260px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 leading-relaxed placeholder:text-slate-300 shadow-2xs"
            spellCheck
            autoFocus
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1 px-1">
            <span>
              {isListenType
                ? 'Capitalization, punctuation, and correct spelling count toward accuracy'
                : 'Aim for structured paragraphs, varied subordination, and precise vocabulary'}
            </span>
            <span className="font-mono font-semibold text-slate-700">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
