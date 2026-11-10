import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

// Fallback curated TED / Academic YouTube sources so EVERY Dictogloss passage
// can play a real human voice via stt-backend even if created before youtubeSource was added!
const DEFAULT_DICTOGLOSS_YOUTUBE_MAP: Record<
  string,
  { clipKey: string; url: string; startTime: string; endTime: string; speaker: string }
> = {
  'dg-sla-chunking': {
    clipKey: 'yt_boroditsky_duocon',
    url: 'https://www.youtube.com/watch?v=kBEBq2eP19k',
    startTime: '00:30',
    endTime: '01:35',
    speaker: 'Prof. Lera Boroditsky (Duocon — Language & Cognition)',
  },
  'dg-det-architectural-acoustics': {
    clipKey: 'yt_treasure_speech',
    url: 'https://www.youtube.com/watch?v=eIho2S0ZahI',
    startTime: '00:20',
    endTime: '01:25',
    speaker: 'Julian Treasure (TED — Sound & Acoustics)',
  },
  'dg-det-sleep-consolidation': {
    clipKey: 'yt_laraboyd_neuro',
    url: 'https://www.youtube.com/watch?v=LNHBMFCzznE',
    startTime: '00:30',
    endTime: '01:35',
    speaker: 'Dr. Lara Boyd (TEDx — Brain & Memory Consolidation)',
  },
  'dg-conversation-brain-capital': {
    clipKey: 'yt_boroditsky_ted',
    url: 'https://www.youtube.com/watch?v=RKK7wGAYP6k',
    startTime: '00:20',
    endTime: '01:25',
    speaker: 'Prof. Lera Boroditsky (TED — Cognitive Diversity)',
  },
};

export function DictoglossBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);
  const communicativePressure = useSessionStore((s) => s.activeRun?.communicativePressure);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [phase, setPhase] = useState<'listen' | 'reconstruct'>('listen');
  const [playCount, setPlayCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [downloadingHumanAudio, setDownloadingHumanAudio] = useState(false);
  const [audioStatusMsg, setAudioStatusMsg] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const response = draftResponses[block.id];
  const fragmentNotes = response?.fragmentNotes ?? '';
  const reconstructedText = response?.textOrTranscript ?? '';

  useEffect(() => {
    const loadDictoglossItems = async () => {
      const [all, doneSet] = await Promise.all([
        db.questionBank.toArray(),
        getCompletedQuestionIds(),
      ]);
      setCompletedIds(doneSet);

      let manifest: Record<string, { audioUrl: string; text: string }> = {};
      let backendOnline = false;
      try {
        const res = await fetch(`${BACKEND_BASE}/audio/manifest`);
        if (res.ok) {
          backendOnline = true;
          manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
        }
      } catch {
        backendOnline = false;
      }

      const hydrated: QuestionBankItem[] = [];
      for (const q of all) {
        const fallbackYt = DEFAULT_DICTOGLOSS_YOUTUBE_MAP[q.id];
        const ytSource = q.youtubeSource ?? fallbackYt;
        const clipKey = ytSource?.clipKey;

        if (clipKey && manifest[clipKey]) {
          const cached = manifest[clipKey];
          const verbatim = cached.text?.trim() || q.sourceAudioText || q.prompt;
          const upgraded: QuestionBankItem = {
            ...q,
            youtubeSource: ytSource,
            audioUrl: normalizeAudioUrl(cached.audioUrl),
            sourceAudioText: verbatim,
            prompt: verbatim,
          };
          await db.questionBank.put(upgraded);
          hydrated.push(upgraded);
        } else {
          hydrated.push({
            ...q,
            youtubeSource: ytSource,
            audioUrl:
              backendOnline && q.audioUrl && !clipKey
                ? normalizeAudioUrl(q.audioUrl)
                : undefined,
          });
        }
      }

      // Include all Dictogloss items AND any downloaded/linked Human Audio talks
      const items = hydrated.filter(
        (q) =>
          q.tags.includes('dictogloss') ||
          q.skill === 'listening' ||
          Boolean(q.audioUrl) ||
          Boolean(q.youtubeSource)
      );

      items.sort((a, b) => {
        // Prioritize items with local human MP3 ready first, then unseen items
        const aHuman = a.audioUrl ? 2 : a.youtubeSource ? 1 : 0;
        const bHuman = b.audioUrl ? 2 : b.youtubeSource ? 1 : 0;
        if (aHuman !== bHuman) return bHuman - aHuman;
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        return aDone - bDone;
      });

      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
      } else {
        const firstWithHumanAudio = finalList.findIndex(
          (q) => Boolean(q.audioUrl) && !doneSet.has(q.id)
        );
        const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
        setSelectedIdx(
          firstWithHumanAudio >= 0
            ? firstWithHumanAudio
            : firstUnseen >= 0
            ? firstUnseen
            : 0
        );
      }
    };
    void loadDictoglossItems();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [block.questionSetId]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const ytSource =
    currentItem?.youtubeSource ??
    (currentItem ? DEFAULT_DICTOGLOSS_YOUTUBE_MAP[currentItem.id] : undefined);
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research indicates that grammatical accuracy emerges naturally when learners internalize multi-word collocation chunks as unified perceptual units rather than assembling individual words through explicit grammatical rules.';

  // Downloads real human audio from stt-backend on demand and plays it immediately
  const handleDownloadAndPlayHumanAudio = useCallback(async () => {
    if (!currentItem || !ytSource) return false;
    setDownloadingHumanAudio(true);
    setAudioStatusMsg(
      `Fetching real human voice (${ytSource.speaker}) via stt-backend...`
    );
    try {
      const res = await fetch(`${BACKEND_BASE}/audio/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytSource.url,
          startTime: ytSource.startTime,
          endTime: ytSource.endTime,
          clipKey: ytSource.clipKey,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { audioUrl: string; text: string };
      const cleanUrl = normalizeAudioUrl(data.audioUrl);
      const verbatim = data.text?.trim() || currentItem.sourceAudioText || currentItem.prompt;
      const updatedItem: QuestionBankItem = {
        ...currentItem,
        youtubeSource: ytSource,
        audioUrl: cleanUrl,
        sourceAudioText: verbatim,
        prompt: verbatim,
      };
      await db.questionBank.put(updatedItem);
      setPassages((prev) =>
        prev.map((p, idx) => (idx === selectedIdx ? updatedItem : p))
      );
      setAudioStatusMsg('✓ Real Human Audio ready! Playing now...');
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.src = cleanUrl;
          audioRef.current.currentTime = 0;
          void audioRef.current.play();
          setIsPlaying(true);
        }
      }, 150);
      return true;
    } catch {
      setAudioStatusMsg(
        '⚠️ Local stt-backend (port 8000) is offline or clip not cached yet — falling back to Browser TTS.'
      );
      return false;
    } finally {
      setDownloadingHumanAudio(false);
    }
  }, [currentItem, selectedIdx, ytSource]);

  const handlePlayPassage = useCallback(async () => {
    // 1. If Real Human MP3 is already on disk, play it directly!
    if (humanAudioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setIsPlaying(true);
      return;
    }

    // 2. If a curated YouTube human talk is linked, auto-fetch the real human voice from stt-backend!
    if (ytSource) {
      const ok = await handleDownloadAndPlayHumanAudio();
      if (ok) return;
    }

    // 3. Only use Browser TTS if stt-backend is unreachable
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourcePassage);
    utterance.lang = 'en-US';
    utterance.rate = 0.98;
    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => {
      setIsPlaying(false);
      setPlayCount((c) => c + 1);
    };
    window.speechSynthesis.speak(utterance);
  }, [
    handleDownloadAndPlayHumanAudio,
    humanAudioUrl,
    sourcePassage,
    ytSource,
  ]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const words = val.trim().split(/\s+/).filter(Boolean);
    if (words.length > 25) return;
    updateResponse(block.id, {
      fragmentNotes: val,
      promptSnapshot: sourcePassage,
      questionId: currentItem?.id,
    });
  };

  const handleReconstructionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (communicativePressure && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
    }
  };

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\s+/).length : 0;
  const reconWordCount = reconstructedText.trim()
    ? reconstructedText.trim().split(/\s+/).length
    : 0;

  return (
    <div className="space-y-5">
      {/* Step-by-Step How-To Guide Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-4 space-y-2.5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <WhisperLiveIndicator />
            <span
              className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                humanAudioUrl
                  ? 'bg-green-500 text-slate-950'
                  : 'bg-primary-500/20 text-primary-300 border border-primary-400/40'
              }`}
            >
              {humanAudioUrl
                ? '🎙️ Real Human MP3 Loaded & Synced'
                : ytSource
                ? `🎬 Human Talk Linked: ${ytSource.speaker}`
                : '🔊 Audio Track'}
            </span>
          </div>

          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setPhase('listen');
                setAudioStatusMsg(null);
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1 text-xs font-semibold text-slate-900 bg-white rounded-lg cursor-pointer max-w-[260px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                const hasMp3 = Boolean(p.audioUrl);
                return (
                  <option key={p.id} value={idx}>
                    {hasMp3 ? '🎙️ [Human MP3] ' : '🎬 [TED Clip] '}
                    {isDone ? '✓ ' : '✨ '}
                    {p.sourceAttribution || p.prompt.slice(0, 32)}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs">
          <div
            className={`p-2.5 rounded-xl border ${
              phase === 'listen' && playCount === 0
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }`}
          >
            <strong className="text-primary-300 block">Step 1: 1st Listen (Hands Off)</strong>
            Click Play and listen to the human speaker to grasp the main thesis and cause-and-effect links.
          </div>
          <div
            className={`p-2.5 rounded-xl border ${
              phase === 'listen' && playCount >= 1
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }`}
          >
            <strong className="text-primary-300 block">Step 2: 2nd Listen (Fragment Notes)</strong>
            Play a second time and type only 2–4 word shorthand keywords (max 25 words).
          </div>
          <div
            className={`p-2.5 rounded-xl border ${
              phase === 'reconstruct'
                ? 'bg-primary-950/90 border-primary-400 text-white'
                : 'bg-slate-800/80 border-slate-700 text-slate-300'
            }`}
          >
            <strong className="text-primary-300 block">Step 3: Reconstruct Meaning</strong>
            Rebuild the full meaning in your own C1/C2 sentences (not word-for-word memorization).
          </div>
        </div>
      </div>

      {/* Phase Toggle Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700">
          Current Stage:{' '}
          {phase === 'listen'
            ? 'Phase 1 — Listening to Human Speaker & Taking Shorthand Notes'
            : 'Phase 2 — Meaning Reconstruction'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPhase('listen')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer ${
              phase === 'listen' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            1. Listen & Fragment Notes
          </button>
          <button
            type="button"
            onClick={() => {
              if (audioRef.current) audioRef.current.pause();
              if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              setIsPlaying(false);
              setPhase('reconstruct');
            }}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer ${
              phase === 'reconstruct' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            2. Reconstruct Meaning →
          </button>
        </div>
      </div>

      {/* Hidden HTML5 Audio Element for Real Human MP3 Playback */}
      <audio
        ref={audioRef}
        src={humanAudioUrl || undefined}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setPlayCount((c) => c + 1);
        }}
        className="hidden"
      />

      {phase === 'listen' ? (
        <div className="bg-accent-50 border-2 border-accent-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs font-bold text-accent-900">
                Audio Listens Used: {playCount} / 2 Recommended •{' '}
                {humanAudioUrl
                  ? '🎙️ Real Human Audio Active'
                  : ytSource
                  ? `🎬 Auto-Loads Real Human Voice (${ytSource.speaker})`
                  : 'Browser Voice'}
              </span>
              <p className="text-xs text-slate-600">
                The transcript is hidden during listening to train your working memory.
              </p>
              {audioStatusMsg && (
                <p className="text-xs font-semibold text-primary-800 mt-1">
                  {audioStatusMsg}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isPlaying && (
                <button
                  type="button"
                  onClick={() => {
                    if (audioRef.current) audioRef.current.pause();
                    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                      window.speechSynthesis.cancel();
                    }
                    setIsPlaying(false);
                  }}
                  className="px-4 py-3 bg-slate-900 text-white text-xs font-bold rounded-xl cursor-pointer"
                >
                  ⏹ Stop Audio
                </button>
              )}
              <button
                type="button"
                onClick={() => void handlePlayPassage()}
                disabled={isPlaying || downloadingHumanAudio}
                className="px-5 py-3 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer shadow-xs"
              >
                {downloadingHumanAudio
                  ? '⏳ Loading Real Human Voice...'
                  : isPlaying
                  ? '🔊 Playing Human Lecture Audio...'
                  : playCount === 0
                  ? '▶ Play Human Audio (1st Listen: Just Listen)'
                  : '▶ Play Human Audio Again (2nd Listen: Fragment Notes)'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Shorthand Fragment Notes (Abbreviations, arrows, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: grammar accuracy <- multi-word chunks != isolated words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Do not write full sentences here — just key concepts</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                  window.speechSynthesis.cancel();
                }
                setIsPlaying(false);
                setPhase('reconstruct');
              }}
              className="px-5 py-2.5 bg-primary-600 text-white text-xs font-bold rounded-xl hover:bg-primary-700 cursor-pointer shadow-xs"
            >
              Lock Audio & Start Reconstruction →
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-amber-900">Your Shorthand Fragment Notes:</p>
              <p className="text-sm font-mono text-amber-800 mt-0.5">
                {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
              </p>
            </div>
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-bold text-primary-700 hover:underline">
                Peek at Verbatim Human Transcript (After Attempting)
              </summary>
              <p className="mt-2 p-3 bg-white rounded-lg border border-slate-200 max-w-xl text-slate-800">
                {sourcePassage}
              </p>
            </details>
          </div>

          <textarea
            value={reconstructedText}
            onKeyDown={handleReconstructionKeyDown}
            onChange={(e) => {
              const val = e.target.value;
              const wc = val.trim() ? val.trim().split(/\s+/).length : 0;
              updateResponse(block.id, {
                textOrTranscript: val,
                promptSnapshot: sourcePassage,
                questionId: currentItem?.id,
              });
              if (wc >= 20 && currentItem && !completedIds.has(currentItem.id)) {
                void markQuestionCompleted(currentItem.id);
                setCompletedIds((prev) => new Set(prev).add(currentItem.id));
              }
            }}
            placeholder="Reconstruct the passage's full meaning in your own words using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[220px] p-4 text-base text-slate-800 bg-white border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>You are graded on meaning retention + C1/C2 grammar, not exact word matching</span>
            <span className="font-mono font-semibold text-slate-700">
              {reconWordCount} {reconWordCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
