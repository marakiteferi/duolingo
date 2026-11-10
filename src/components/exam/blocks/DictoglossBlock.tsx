import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
import {
  getCompletedQuestionIds,
  markQuestionCompleted,
} from '../../../utils/adaptive';
import type { BlockConfig, QuestionBankItem } from '../../../types';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

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
      try {
        const res = await fetch(`${BACKEND_BASE}/audio/manifest`);
        if (res.ok) {
          manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
        }
      } catch {
        // Offline or manifest empty
      }

      const hydrated = all.map((q) => {
        if (q.youtubeSource?.clipKey && manifest[q.youtubeSource.clipKey] && !q.audioUrl) {
          const cached = manifest[q.youtubeSource.clipKey];
          return {
            ...q,
            audioUrl: normalizeAudioUrl(cached.audioUrl),
            sourceAudioText: cached.text || q.sourceAudioText,
          };
        }
        return {
          ...q,
          audioUrl: q.audioUrl ? normalizeAudioUrl(q.audioUrl) : q.audioUrl,
        };
      });

      const items = hydrated.filter(
        (q) => Boolean(q.audioUrl) || q.tags.includes('dictogloss') || q.skill === 'listening'
      );

      // Sort UNSEEN passages first, then by human audio availability
      items.sort((a, b) => {
        const aDone = doneSet.has(a.id) ? 1 : 0;
        const bDone = doneSet.has(b.id) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0);
      });

      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
      } else {
        const firstUnseen = finalList.findIndex((q) => !doneSet.has(q.id));
        if (firstUnseen >= 0) setSelectedIdx(firstUnseen);
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
  const sourcePassage =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'Second-language acquisition research demonstrates that transitioning from intermediate comprehension to advanced production requires retrieving multi-word formulaic sequences under communicative time pressure rather than assembling isolated vocabulary through conscious grammar rules.';

  const handlePlayPassage = useCallback(() => {
    if (humanAudioUrl && audioRef.current) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play();
      setIsPlaying(true);
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sourcePassage);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.onstart = () => setIsPlaying(true);
    utterance.onend = () => {
      setIsPlaying(false);
      setPlayCount((c) => c + 1);
    };
    window.speechSynthesis.speak(utterance);
  }, [humanAudioUrl, sourcePassage]);

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

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-accent-700">
            Dictogloss Working-Memory Protocol {humanAudioUrl ? '(🎙️ Real Human Audio)' : '(TTS Fallback)'}
          </span>
          <p className="text-xs text-slate-500 mt-0.5">
            Phase 1: Listen & take compressed 2-4 word fragment notes. Phase 2: Reconstruct full meaning from memory.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg cursor-pointer max-w-[220px]"
            >
              {passages.map((p, idx) => {
                const isDone = completedIds.has(p.id);
                return (
                  <option key={p.id} value={idx}>
                    {isDone ? '✓ [Done] ' : '✨ [Unseen] '}
                    {p.sourceAttribution || p.prompt.slice(0, 32)}
                  </option>
                );
              })}
            </select>
          )}
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
            2. Reconstruct Meaning
          </button>
        </div>
      </div>

      {humanAudioUrl && (
        <audio
          ref={audioRef}
          src={humanAudioUrl}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setPlayCount((c) => c + 1);
          }}
          className="hidden"
        />
      )}

      {phase === 'listen' ? (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-accent-800">
              Audio Listens Used: {playCount} / 2 (Transcript hidden to train working memory)
            </span>
            <button
              type="button"
              onClick={handlePlayPassage}
              disabled={isPlaying}
              className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-xl disabled:opacity-50 cursor-pointer"
            >
              {isPlaying
                ? 'Playing Lecture Audio...'
                : playCount === 0
                ? '▶ Play Passage (1st Listen: Comprehension)'
                : '▶ Play Again (2nd Listen: Fragment Note-Taking)'}
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Fragment Notes Only (Abbreviations, symbols, keywords — max 25 words):
            </label>
            <input
              type="text"
              value={fragmentNotes}
              onChange={handleNotesChange}
              placeholder="e.g., SLA: interm -> adv req multi-word chunks / time press != isol words"
              className="w-full px-3.5 py-2.5 bg-white border border-accent-300 rounded-lg text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-accent-500"
            />
            <div className="flex justify-between mt-1 text-[11px] text-slate-500">
              <span>Compress spoken clauses into 2–4 word fragments</span>
              <span>{fragmentWordCount} / 25 fragment words</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                setPhase('reconstruct');
              }}
              className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Lock Audio & Start Reconstruction →
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5">
            <p className="text-xs font-bold text-amber-900">Your Compressed Fragment Notes:</p>
            <p className="text-sm font-mono text-amber-800 mt-1">
              {fragmentNotes || '(No fragment notes taken — reconstruct from working memory)'}
            </p>
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
              if (wc >= 25 && currentItem && !completedIds.has(currentItem.id)) {
                void markQuestionCompleted(currentItem.id);
                setCompletedIds((prev) => new Set(prev).add(currentItem.id));
              }
            }}
            placeholder="Reconstruct the passage's full meaning using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[240px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
