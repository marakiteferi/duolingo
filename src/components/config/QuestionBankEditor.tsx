import { useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import type { QuestionBankItem, DETSkill, DETQuestionType } from '../../types';
import { generateId } from '../../utils/helpers';

const BACKEND_BASE = 'http://127.0.0.1:8000';

export function QuestionBankEditor() {
  const questions = useConfigStore((s) => s.questions);
  const saveQuestion = useConfigStore((s) => s.saveQuestion);
  const deleteQuestion = useConfigStore((s) => s.deleteQuestion);

  const [filterSkill, setFilterSkill] = useState<DETSkill | 'all'>('all');
  const [editingQuestion, setEditingQuestion] = useState<QuestionBankItem | null>(null);
  const [chunksInput, setChunksInput] = useState<string>('');
  const [tagsInput, setTagsInput] = useState<string>('');

  // Human Audio Upload & YouTube Clipper state
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytStart, setYtStart] = useState('00:30');
  const [ytEnd, setYtEnd] = useState('01:45');
  const [audioStatus, setAudioStatus] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const skills: { value: DETSkill; label: string }[] = [
    { value: 'reading', label: 'Reading' },
    { value: 'writing', label: 'Writing' },
    { value: 'speaking', label: 'Speaking / Shadowing' },
    { value: 'listening', label: 'Listening / Dictogloss' },
  ];

  const questionTypes: { value: DETQuestionType; label: string; skill: DETSkill }[] = [
    { value: 'read-aloud', label: 'Read Aloud / Shadowing', skill: 'speaking' },
    { value: 'listen-and-type', label: 'Listen & Type / Dictogloss', skill: 'listening' },
    { value: 'write-about-photo', label: 'Collocation Chunk Writing', skill: 'writing' },
    { value: 'interactive-writing', label: 'Interactive Writing', skill: 'writing' },
    { value: 'interactive-speaking', label: 'Interactive Speaking', skill: 'speaking' },
    { value: 'speaking-sample', label: 'Speaking Sample', skill: 'speaking' },
  ];

  const filtered =
    filterSkill === 'all' ? questions : questions.filter((q) => q.skill === filterSkill);

  const openEditor = (q: QuestionBankItem) => {
    setEditingQuestion({ ...q });
    setChunksInput((q.targetChunks ?? []).join(', '));
    setTagsInput((q.tags ?? []).join(', '));
    setAudioStatus(null);
    setAudioError(null);
  };

  const handleNew = () => {
    openEditor({
      id: generateId(),
      skill: 'speaking',
      type: 'read-aloud',
      prompt: '',
      sourceAudioText: '',
      audioUrl: '',
      targetChunks: [],
      difficulty: 'hard',
      tags: ['shadowing'],
    });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus('Uploading human audio & auto-transcribing with Faster-Whisper...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('auto_transcribe', 'true');

      const res = await fetch(`${BACKEND_BASE}/audio/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Upload failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(`✓ Human audio attached (${data.duration}s) & transcribed by Faster-Whisper!`);
    } catch (err) {
      setAudioError(
        err instanceof Error
          ? err.message
          : 'Could not connect to stt-backend on port 8000.'
      );
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleYoutubeImport = async () => {
    if (!ytUrl.trim() || !editingQuestion) return;
    setUploadingAudio(true);
    setAudioError(null);
    setAudioStatus(`Extracting clip (${ytStart} - ${ytEnd}) via yt-dlp & transcribing with Whisper...`);

    try {
      const res = await fetch(`${BACKEND_BASE}/audio/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytUrl.trim(),
          startTime: ytStart.trim(),
          endTime: ytEnd.trim(),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'yt-dlp import failed' }));
        throw new Error(errData.detail || 'yt-dlp import failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
        duration: number;
      };

      setEditingQuestion({
        ...editingQuestion,
        audioUrl: data.audioUrl,
        sourceAudioText: data.text || editingQuestion.sourceAudioText,
        prompt: editingQuestion.prompt || data.text,
      });
      setAudioStatus(`✓ Imported ${data.duration}s human audio clip & auto-transcribed!`);
      setYtUrl('');
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'YouTube import failed');
      setAudioStatus(null);
    } finally {
      setUploadingAudio(false);
    }
  };

  const handleSave = async () => {
    if (!editingQuestion) return;
    const parsedChunks = chunksInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedTags = tagsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    await saveQuestion({
      ...editingQuestion,
      targetChunks: parsedChunks.length > 0 ? parsedChunks : undefined,
      tags: parsedTags,
    });
    setEditingQuestion(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Question Bank & Human Audio Studio
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Add custom prompts, upload real human MP3/WAV recordings, or slice YouTube/TED talks for Shadowing & Dictogloss.
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 cursor-pointer"
        >
          + New Question / Audio Drill
        </button>
      </div>

      {/* Skill filter tabs */}
      {!editingQuestion && (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => setFilterSkill('all')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                filterSkill === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All ({questions.length})
            </button>
            {skills.map((s) => {
              const count = questions.filter((q) => q.skill === s.value).length;
              return (
                <button
                  key={s.value}
                  onClick={() => setFilterSkill(s.value)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                    filterSkill === s.value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {s.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            {filtered.map((q) => (
              <div
                key={q.id}
                className="bg-white rounded-xl border border-slate-200 p-4 hover:border-primary-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-accent-100 text-accent-700">
                        {q.skill}
                      </span>
                      <span className="text-xs text-slate-500 font-mono">{q.type}</span>
                      {q.audioUrl && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                          🎙️ Real Human Audio Attached
                        </span>
                      )}
                      {q.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                    <p className="text-sm text-slate-800 font-medium line-clamp-2">{q.prompt}</p>
                    {q.audioUrl && (
                      <audio controls src={q.audioUrl} className="h-8 w-full max-w-md mt-1" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEditor(q)}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit / Audio
                    </button>
                    <button
                      onClick={() => deleteQuestion(q.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Question & Human Audio Editor Modal */}
      {editingQuestion && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-base font-bold text-slate-900">
              Customize Prompt & Real Human Audio
            </h3>
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800"
            >
              ✕ Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Skill</label>
              <select
                value={editingQuestion.skill}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, skill: e.target.value as DETSkill })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {skills.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Question Type</label>
              <select
                value={editingQuestion.type}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    type: e.target.value as DETQuestionType,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {questionTypes.map((qt) => (
                  <option key={qt.value} value={qt.value}>
                    {qt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Tags (use "shadowing" or "dictogloss")
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="shadowing, dictogloss, vocab"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          {/* REAL HUMAN AUDIO STUDIO */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-primary-700">
                  🎙️ Real Human Audio Source (For Shadowing & Dictogloss)
                </h4>
                <p className="text-xs text-slate-500">
                  Upload an MP3/WAV file or slice a YouTube/TED video. Faster-Whisper will automatically transcribe it!
                </p>
              </div>
            </div>

            {/* Option A: Upload local MP3/WAV */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Option 1: Upload Local Human Audio (.mp3, .wav, .m4a)
                </label>
                <input
                  type="file"
                  accept="audio/*"
                  disabled={uploadingAudio}
                  onChange={handleFileUpload}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                />
              </div>

              {/* Option B: YouTube / TED Clipper */}
              <div className="bg-white p-3.5 rounded-lg border border-slate-200 space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Option 2: Slice YouTube / TED Talk Clip (via yt-dlp)
                </label>
                <input
                  type="url"
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded text-xs"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={ytStart}
                    onChange={(e) => setYtStart(e.target.value)}
                    placeholder="00:30"
                    className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    title="Start Time (MM:SS)"
                  />
                  <span className="text-xs text-slate-400">to</span>
                  <input
                    type="text"
                    value={ytEnd}
                    onChange={(e) => setYtEnd(e.target.value)}
                    placeholder="01:45"
                    className="w-20 px-2 py-1 border border-slate-300 rounded text-xs font-mono"
                    title="End Time (MM:SS)"
                  />
                  <button
                    type="button"
                    disabled={uploadingAudio || !ytUrl.trim()}
                    onClick={handleYoutubeImport}
                    className="flex-1 py-1.5 px-3 bg-accent-600 text-white text-xs font-semibold rounded hover:bg-accent-700 disabled:opacity-50 cursor-pointer"
                  >
                    {uploadingAudio ? 'Processing...' : 'Import & Transcribe'}
                  </button>
                </div>
              </div>
            </div>

            {/* Option C: Direct Audio URL */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Audio Stream URL (Auto-filled on upload, or paste any direct .mp3 link):
              </label>
              <input
                type="text"
                value={editingQuestion.audioUrl ?? ''}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, audioUrl: e.target.value })
                }
                placeholder="http://127.0.0.1:8000/audio/human_clip.mp3"
                className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono"
              />
            </div>

            {editingQuestion.audioUrl && (
              <div className="pt-1">
                <audio controls src={editingQuestion.audioUrl} className="w-full h-9" />
              </div>
            )}

            {audioStatus && (
              <div className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg p-2.5">
                {audioStatus}
              </div>
            )}
            {audioError && (
              <div className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                {audioError}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Task Prompt / Verbatim Human Transcript (Auto-populated by Whisper on upload):
            </label>
            <textarea
              value={editingQuestion.prompt}
              onChange={(e) =>
                setEditingQuestion({
                  ...editingQuestion,
                  prompt: e.target.value,
                  sourceAudioText: e.target.value,
                })
              }
              rows={4}
              placeholder="The human speaker's transcript or writing task prompt..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Target Multi-Word Collocation Chunks (comma-separated, for Vocab Writing):
            </label>
            <input
              type="text"
              value={chunksInput}
              onChange={(e) => setChunksInput(e.target.value)}
              placeholder="rigorous empirical validation, shift the research paradigm, bear the consequences"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              150-Band Reference Sample Answer (Optional):
            </label>
            <textarea
              value={editingQuestion.sampleAnswer ?? ''}
              onChange={(e) =>
                setEditingQuestion({ ...editingQuestion, sampleAnswer: e.target.value })
              }
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="px-4 py-2 text-sm text-slate-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
            >
              Save Question & Audio
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
