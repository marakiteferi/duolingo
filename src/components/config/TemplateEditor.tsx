import { useEffect, useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { ensureDatabaseUpgraded } from '../../db/database';
import { StudyPlanDashboard } from './StudyPlanDashboard';
import type {
  Block,
  BlockType,
  DETQuestionType,
  QuestionBankItem,
  SessionTemplate,
} from '../../types';
import { formatTime, generateId } from '../../utils/helpers';

const BLOCK_TYPE_OPTIONS: { value: BlockType; label: string; badge: string }[] = [
  { value: 'interactive-reading', label: '📖 Interactive Reading & Read/Complete', badge: 'Reading' },
  { value: 'shadowing', label: '🗣️ Arguelles Shadowing (TED / Human Audio)', badge: 'Speaking/Audio' },
  { value: 'dictogloss', label: '🎧 Dictogloss Working-Memory Reconstruction', badge: 'Listening' },
  { value: 'vocab-writing', label: '🧩 Collocation Chunk Writing (SRS)', badge: 'Writing' },
  { value: 'speaking', label: '🎙️ Timed Verbatim Speaking', badge: 'Speaking' },
  { value: 'brain-dump', label: '📝 Brain Dump & Structural Outline', badge: 'Writing' },
  { value: 'mock-test', label: '🎯 Timed Adaptive Mock Test', badge: 'All Skills' },
  { value: 'custom', label: '⚙️ Custom Block', badge: 'Custom' },
];

const SUBTYPE_OPTIONS_BY_BLOCK: Partial<
  Record<BlockType, { value: DETQuestionType | 'adaptive'; label: string }[]>
> = {
  'interactive-reading': [
    { value: 'read-and-complete', label: '✍️ Read & Complete (1-Letter-Per-Box Cloze)' },
    { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
  ],
  'mock-test': [
    { value: 'adaptive', label: '🎯 Adaptive (Targets Weakest Skill)' },
    { value: 'read-and-complete', label: '✍️ Read & Complete (Letter Boxes)' },
    { value: 'interactive-reading', label: '📖 Interactive Reading (6-Step Suite)' },
    { value: 'interactive-writing', label: '📝 Interactive Writing' },
    { value: 'write-about-photo', label: '🧩 Collocation Chunk Writing' },
    { value: 'listen-and-type', label: '🎧 Listen & Type / Dictogloss' },
    { value: 'read-aloud', label: '🗣️ Read Aloud / Shadowing' },
    { value: 'interactive-speaking', label: '🎙️ Interactive Speaking' },
    { value: 'speaking-sample', label: '🎤 Speaking Sample' },
  ],
  speaking: [
    { value: 'adaptive', label: '🎯 Any Speaking Prompt (Adaptive)' },
    { value: 'speaking-sample', label: '🎤 Speaking Sample (90s Monologue)' },
    { value: 'interactive-speaking', label: '🎙️ Interactive Speaking' },
  ],
};

const QUICK_DURATION_PRESETS: { label: string; sec: number }[] = [
  { label: '60s', sec: 60 },
  { label: '90s', sec: 90 },
  { label: '3m', sec: 180 },
  { label: '5m', sec: 300 },
  { label: '8m', sec: 480 },
];

function getEligibleQuestionsForBlock(
  block: Block,
  allQuestions: QuestionBankItem[]
): QuestionBankItem[] {
  switch (block.type) {
    case 'interactive-reading':
      if (block.preferredQuestionType === 'read-and-complete') {
        return allQuestions.filter((q) => q.type === 'read-and-complete');
      }
      if (block.preferredQuestionType === 'interactive-reading') {
        return allQuestions.filter((q) => q.type === 'interactive-reading');
      }
      return allQuestions.filter(
        (q) => q.type === 'read-and-complete' || q.type === 'interactive-reading'
      );
    case 'shadowing':
      return allQuestions.filter(
        (q) =>
          Boolean(q.audioUrl) ||
          Boolean(q.youtubeSource) ||
          q.tags.includes('shadowing') ||
          q.type === 'read-aloud'
      );
    case 'dictogloss':
      return allQuestions.filter(
        (q) =>
          Boolean(q.audioUrl) ||
          q.tags.includes('dictogloss') ||
          q.skill === 'listening'
      );
    case 'vocab-writing':
      return allQuestions.filter(
        (q) => q.skill === 'writing' || q.tags.includes('vocab') || Boolean(q.targetChunks?.length)
      );
    case 'speaking':
      return allQuestions.filter(
        (q) =>
          q.skill === 'speaking' &&
          (q.type === 'speaking-sample' || q.type === 'interactive-speaking')
      );
    case 'brain-dump':
      return allQuestions.filter((q) => q.skill === 'writing');
    case 'mock-test':
      if (block.preferredQuestionType && block.preferredQuestionType !== 'adaptive') {
        return allQuestions.filter((q) => q.type === block.preferredQuestionType);
      }
      return allQuestions;
    default:
      return allQuestions;
  }
}

export function TemplateEditor() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const questions = useConfigStore((s) => s.questions);
  const loadQuestions = useConfigStore((s) => s.loadQuestions);
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const loadEvalPrompts = useConfigStore((s) => s.loadEvalPrompts);
  const editingTemplate = useConfigStore((s) => s.editingTemplate);
  const setEditingTemplate = useConfigStore((s) => s.setEditingTemplate);
  const createTemplate = useConfigStore((s) => s.createTemplate);
  const saveTemplate = useConfigStore((s) => s.saveTemplate);
  const deleteTemplate = useConfigStore((s) => s.deleteTemplate);
  const duplicateTemplate = useConfigStore((s) => s.duplicateTemplate);

  const setSelectedTemplateId = useSessionStore((s) => s.setSelectedTemplateId);
  const setView = useAppStore((s) => s.setView);

  const [activeTab, setActiveTab] = useState<'plan' | 'architect'>('plan');

  useEffect(() => {
    void ensureDatabaseUpgraded().then(() => {
      void loadTemplates();
      void loadQuestions();
      void loadEvalPrompts();
    });
  }, [loadTemplates, loadQuestions, loadEvalPrompts]);

  const findEvalIdForType = (type: BlockType): string => {
    return (
      evalPrompts.find((ep) => ep.appliesToType === type)?.id ??
      evalPrompts[0]?.id ??
      ''
    );
  };

  const handleLaunchTemplateInExam = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setView('exam');
  };

  const handleCreatePresetBlueprint = (
    preset: 'full-det' | 'audio-bootcamp' | 'reading-sprint'
  ) => {
    setActiveTab('architect');
    const now = new Date().toISOString();
    let blueprint: SessionTemplate;

    if (preset === 'full-det') {
      blueprint = {
        id: generateId(),
        name: 'Full DET 140–150 High-Stakes Simulation',
        description:
          'Read & Complete (3m) -> 6-Step Interactive Reading (8m) -> Collocation Writing (5m) -> Dictogloss (4m) -> 90s Verbatim Speaking.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. Read & Complete (1-Letter-Per-Box Cloze)',
            type: 'interactive-reading',
            preferredQuestionType: 'read-and-complete',
            durationSec: 180,
            instructions: 'Complete all missing word suffixes under strict time pressure.',
            autoAdvance: true,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '2. Interactive Reading (6-Step Suite)',
            type: 'interactive-reading',
            preferredQuestionType: 'interactive-reading',
            durationSec: 480,
            instructions: 'Complete all 6 steps of the academic passage.',
            autoAdvance: true,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '3. Collocation Chunk Precision Writing',
            type: 'vocab-writing',
            durationSec: 300,
            instructions: 'Incorporate all 4 C1/C2 multi-word collocation chunks.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('vocab-writing'),
          },
          {
            id: generateId(),
            name: '4. Dictogloss Lecture Reconstruction',
            type: 'dictogloss',
            durationSec: 240,
            instructions: 'Listen twice with fragment notes, then reconstruct the thesis.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('dictogloss'),
          },
          {
            id: generateId(),
            name: '5. 90-Second Verbatim Speaking Sample',
            type: 'speaking',
            preferredQuestionType: 'speaking-sample',
            durationSec: 90,
            instructions: 'Speak continuously for 90 seconds with complex subordination.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('speaking'),
          },
        ],
      };
    } else if (preset === 'audio-bootcamp') {
      blueprint = {
        id: generateId(),
        name: 'YouTube TED Shadowing & Dictogloss Bootcamp',
        description:
          'Warm-up Shadowing (1.0x) -> Blind Shadowing -> Dictogloss Reconstruction -> 90s Spoken Transfer.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. TED Talk Shadowing (Transcript Visible)',
            type: 'shadowing',
            durationSec: 180,
            speechSpeed: 1.0,
            blindShadowing: false,
            instructions: 'Shadow the human speaker with a 0.5s lag, matching pitch and stress.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('shadowing'),
          },
          {
            id: generateId(),
            name: '2. Blind Auditory-Motor Shadowing (Transcript Hidden)',
            type: 'shadowing',
            durationSec: 180,
            speechSpeed: 0.95,
            blindShadowing: true,
            instructions: 'Shadow purely by ear without reading the transcript.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('shadowing'),
          },
          {
            id: generateId(),
            name: '3. Dictogloss Working-Memory Synthesis',
            type: 'dictogloss',
            durationSec: 240,
            instructions: 'Take 2-4 word fragment notes and reconstruct the speaker’s argument.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('dictogloss'),
          },
          {
            id: generateId(),
            name: '4. 90s Spontaneous Oral Synthesis',
            type: 'speaking',
            durationSec: 90,
            instructions: 'Speak for 90s reusing the prosody and chunks from the TED talk.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('speaking'),
          },
        ],
      };
    } else {
      blueprint = {
        id: generateId(),
        name: 'DET Reading & Lexical Precision Sprint',
        description:
          'Rapid Read & Complete Drill -> 6-Step Interactive Reading -> Collocation Chunk Writing.',
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: generateId(),
            name: '1. Read & Complete Speed Drill',
            type: 'interactive-reading',
            preferredQuestionType: 'read-and-complete',
            durationSec: 180,
            instructions: 'Complete the segmented letter boxes accurately.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '2. 6-Step Interactive Reading Suite',
            type: 'interactive-reading',
            preferredQuestionType: 'interactive-reading',
            durationSec: 420,
            instructions: 'Complete all 6 interactive reading steps.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('interactive-reading'),
          },
          {
            id: generateId(),
            name: '3. Collocation Chunk Paragraph',
            type: 'vocab-writing',
            durationSec: 300,
            instructions: 'Synthesize a C1/C2 paragraph using all target chunks.',
            autoAdvance: false,
            evalPromptId: findEvalIdForType('vocab-writing'),
          },
        ],
      };
    }

    setEditingTemplate(blueprint);
  };

  const handleAddBlock = (type: BlockType = 'interactive-reading') => {
    if (!editingTemplate) return;
    const option = BLOCK_TYPE_OPTIONS.find((o) => o.value === type);
    const defaultDuration =
      type === 'speaking'
        ? 90
        : type === 'shadowing' || type === 'brain-dump'
        ? 180
        : type === 'interactive-reading'
        ? 480
        : 300;

    const newBlock: Block = {
      id: generateId(),
      name: `${editingTemplate.blocks.length + 1}. ${option?.label.replace(/^[^\s]+\s/, '') ?? 'Practice Block'}`,
      type,
      durationSec: defaultDuration,
      preferredQuestionType:
        type === 'interactive-reading' ? 'read-and-complete' : undefined,
      instructions: 'Complete the task below under timed conditions.',
      autoAdvance: false,
      evalPromptId: findEvalIdForType(type),
    };
    setEditingTemplate({
      ...editingTemplate,
      blocks: [...editingTemplate.blocks, newBlock],
    });
  };

  const handleUpdateBlock = (index: number, patch: Partial<Block>) => {
    if (!editingTemplate) return;
    const nextBlocks = editingTemplate.blocks.map((b, i) => {
      if (i !== index) return b;
      const updated = { ...b, ...patch };
      if (patch.type && patch.type !== b.type) {
        updated.evalPromptId = findEvalIdForType(patch.type);
        updated.questionSetId = undefined;
        updated.preferredQuestionType =
          patch.type === 'interactive-reading' ? 'read-and-complete' : undefined;
      }
      return updated;
    });
    setEditingTemplate({ ...editingTemplate, blocks: nextBlocks });
  };

  const handleMoveBlock = (index: number, direction: -1 | 1) => {
    if (!editingTemplate) return;
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= editingTemplate.blocks.length) return;
    const copy = [...editingTemplate.blocks];
    const [moved] = copy.splice(index, 1);
    copy.splice(targetIdx, 0, moved);
    setEditingTemplate({ ...editingTemplate, blocks: copy });
  };

  const handleDuplicateBlock = (index: number) => {
    if (!editingTemplate) return;
    const source = editingTemplate.blocks[index];
    if (!source) return;
    const clone: Block = {
      ...source,
      id: generateId(),
      name: `${source.name} (Copy)`,
    };
    const copy = [...editingTemplate.blocks];
    copy.splice(index + 1, 0, clone);
    setEditingTemplate({ ...editingTemplate, blocks: copy });
  };

  const handleRemoveBlock = (index: number) => {
    if (!editingTemplate) return;
    setEditingTemplate({
      ...editingTemplate,
      blocks: editingTemplate.blocks.filter((_, i) => i !== index),
    });
  };

  return (
    <div className="space-y-6">
      {/* Top Mode Switcher: 21-Day Plan vs Custom Session Architect */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-2 shadow-2xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setEditingTemplate(null);
              setActiveTab('plan');
            }}
            className={`px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
              activeTab === 'plan' && !editingTemplate
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            📅 21-Day Study Plan (3 Daily Sessions)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('architect')}
            className={`px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
              activeTab === 'architect' || Boolean(editingTemplate)
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            🛠️ Custom Session Architect ({templates.length} Templates)
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleCreatePresetBlueprint('full-det')}
            className="px-3 py-1.5 bg-primary-50 text-primary-800 border border-primary-200 text-xs font-bold rounded-lg hover:bg-primary-100 cursor-pointer"
          >
            + Full DET Simulation
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('architect');
              createTemplate();
            }}
            className="px-3.5 py-1.5 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            + Blank Custom Template
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* VIEW 1: 21-DAY STUDY PLAN DASHBOARD                                 */}
      {/* =================================================================== */}
      {activeTab === 'plan' && !editingTemplate && <StudyPlanDashboard />}

      {/* =================================================================== */}
      {/* VIEW 2: SAVED TEMPLATES LIST & CUSTOM ARCHITECT                     */}
      {/* =================================================================== */}
      {activeTab === 'architect' && !editingTemplate && (
        <div className="space-y-3">
          {templates.map((t) => {
            const totalDuration = t.blocks.reduce((sum, b) => sum + b.durationSec, 0);
            return (
              <div
                key={t.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:border-primary-300 transition-colors shadow-2xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2.5">
                      <h3 className="font-bold text-slate-900 text-base">{t.name}</h3>
                      <span className="text-xs font-mono font-bold bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full">
                        {t.blocks.length} blocks • {formatTime(totalDuration)}
                      </span>
                    </div>
                    {t.description && (
                      <p className="text-xs text-slate-500 mt-1">{t.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {t.blocks.map((b, idx) => {
                        const pinnedQ = b.questionSetId
                          ? questions.find((q) => q.id === b.questionSetId)
                          : undefined;
                        return (
                          <span
                            key={b.id}
                            className="text-xs bg-slate-50 border border-slate-200 text-slate-700 px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5"
                          >
                            <strong className="text-primary-700">{idx + 1}.</strong>
                            <span>{b.name}</span>
                            <span className="text-[11px] font-mono text-slate-400">
                              ({formatTime(b.durationSec)})
                            </span>
                            {pinnedQ && (
                              <span className="text-[10px] bg-primary-100 text-primary-800 px-1.5 py-0.5 rounded font-semibold">
                                📌 Pinned
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleLaunchTemplateInExam(t.id)}
                      className="px-3.5 py-2 text-xs font-bold text-white bg-green-600 rounded-lg hover:bg-green-700 cursor-pointer shadow-2xs"
                    >
                      🚀 Launch Session
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTemplate({ ...t })}
                      className="px-3 py-2 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Configure Blocks
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateTemplate(t.id)}
                      className="px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTemplate(t.id)}
                      className="px-2.5 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* =================================================================== */}
      {/* INTERACTIVE SESSION ARCHITECT EDITOR                                */}
      {/* =================================================================== */}
      {editingTemplate && (
        <div className="bg-white rounded-2xl border-2 border-slate-200 p-6 space-y-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-primary-600">
                Session Architect
              </span>
              <h3 className="text-lg font-bold text-slate-900">
                Configuring: {editingTemplate.name || 'Untitled Session'}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold bg-slate-100 text-slate-800 px-3 py-1.5 rounded-lg">
                Total Duration:{' '}
                {formatTime(
                  editingTemplate.blocks.reduce((sum, b) => sum + b.durationSec, 0)
                )}
              </span>
              <button
                type="button"
                onClick={() => setEditingTemplate(null)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                ✕ Close
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Template Name
              </label>
              <input
                type="text"
                value={editingTemplate.name}
                onChange={(e) =>
                  setEditingTemplate({ ...editingTemplate, name: e.target.value })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-semibold"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Session Goal / Description
              </label>
              <input
                type="text"
                value={editingTemplate.description ?? ''}
                onChange={(e) =>
                  setEditingTemplate({
                    ...editingTemplate,
                    description: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              + Quick-Add Block by Skill Type:
            </span>
            <div className="flex flex-wrap gap-2">
              {BLOCK_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleAddBlock(opt.value)}
                  className="px-3 py-1.5 bg-white hover:bg-primary-50 border border-slate-300 hover:border-primary-400 rounded-lg text-xs font-semibold text-slate-800 cursor-pointer transition-colors shadow-2xs"
                >
                  + {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {editingTemplate.blocks.map((b, i) => {
              const mins = Math.floor(b.durationSec / 60);
              const secs = b.durationSec % 60;
              const eligibleQuestions = getEligibleQuestionsForBlock(b, questions);
              const subtypeList = SUBTYPE_OPTIONS_BY_BLOCK[b.type];

              return (
                <div
                  key={b.id}
                  className="bg-slate-50/80 border-2 border-slate-200 rounded-2xl p-5 space-y-4 hover:border-slate-300 transition-all"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-primary-100 text-primary-800">
                        {b.type}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        {formatTime(b.durationSec)}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => handleMoveBlock(i, -1)}
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                      >
                        ↑ Up
                      </button>
                      <button
                        type="button"
                        disabled={i === editingTemplate.blocks.length - 1}
                        onClick={() => handleMoveBlock(i, 1)}
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                      >
                        ↓ Down
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateBlock(i)}
                        className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
                      >
                        ⧉ Clone
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveBlock(i)}
                        className="px-2.5 py-1 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                      >
                        ✕ Remove
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Block Title
                      </label>
                      <input
                        type="text"
                        value={b.name}
                        onChange={(e) => handleUpdateBlock(i, { name: e.target.value })}
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold"
                      />
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Block Engine / Mode
                      </label>
                      <select
                        value={b.type}
                        onChange={(e) =>
                          handleUpdateBlock(i, { type: e.target.value as BlockType })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold"
                      >
                        {BLOCK_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Exact Timer (Min : Sec) & DET Presets
                      </label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={60}
                          value={mins}
                          onChange={(e) => {
                            const m = Math.max(0, Number(e.target.value));
                            handleUpdateBlock(i, {
                              durationSec: Math.max(15, m * 60 + secs),
                            });
                          }}
                          className="w-14 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center"
                        />
                        <span className="text-xs font-bold text-slate-500">m</span>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          step={5}
                          value={secs}
                          onChange={(e) => {
                            const s = Math.max(0, Math.min(59, Number(e.target.value)));
                            handleUpdateBlock(i, {
                              durationSec: Math.max(15, mins * 60 + s),
                            });
                          }}
                          className="w-14 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center"
                        />
                        <span className="text-xs font-bold text-slate-500 mr-1">s</span>
                        {QUICK_DURATION_PRESETS.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            onClick={() => handleUpdateBlock(i, { durationSec: p.sec })}
                            className={`px-2 py-1 rounded text-[11px] font-mono font-bold border cursor-pointer ${
                              b.durationSec === p.sec
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-5">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        📌 Pin Specific Question / Passage ({eligibleQuestions.length} available)
                      </label>
                      <select
                        value={b.questionSetId ?? ''}
                        onChange={(e) =>
                          handleUpdateBlock(i, {
                            questionSetId: e.target.value || undefined,
                          })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      >
                        <option value="">
                          🔄 Unseen-First Automatic Selection (Recommended for 21-Day Plan)
                        </option>
                        {eligibleQuestions.map((q) => (
                          <option key={q.id} value={q.id}>
                            [{q.type}] {q.sourceAttribution ? `(${q.sourceAttribution}) ` : ''}
                            {q.prompt.slice(0, 68)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="lg:col-span-4">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        Sub-Task Mode Filter
                      </label>
                      {subtypeList ? (
                        <select
                          value={b.preferredQuestionType ?? subtypeList[0].value}
                          onChange={(e) =>
                            handleUpdateBlock(i, {
                              preferredQuestionType: e.target.value as
                                | DETQuestionType
                                | 'adaptive',
                            })
                          }
                          className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                        >
                          {subtypeList.map((st) => (
                            <option key={st.value} value={st.value}>
                              {st.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="px-3 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-500">
                          Dedicated {b.type} workflow
                        </div>
                      )}
                    </div>

                    <div className="lg:col-span-3">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        AI Grading Rubric
                      </label>
                      <select
                        value={b.evalPromptId}
                        onChange={(e) =>
                          handleUpdateBlock(i, { evalPromptId: e.target.value })
                        }
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      >
                        {evalPrompts.map((ep) => (
                          <option key={ep.id} value={ep.id}>
                            {ep.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center pt-1">
                    <div className="lg:col-span-6">
                      <input
                        type="text"
                        value={b.instructions}
                        onChange={(e) =>
                          handleUpdateBlock(i, { instructions: e.target.value })
                        }
                        placeholder="Custom instructions displayed at the top of this block..."
                        className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs"
                      />
                    </div>

                    <div className="lg:col-span-6 flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={b.autoAdvance}
                          onChange={(e) =>
                            handleUpdateBlock(i, { autoAdvance: e.target.checked })
                          }
                        />
                        Auto-Advance on Timer End
                      </label>

                      {b.type === 'shadowing' && (
                        <>
                          <label className="flex items-center gap-1.5 text-xs font-semibold text-primary-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(b.blindShadowing)}
                              onChange={(e) =>
                                handleUpdateBlock(i, {
                                  blindShadowing: e.target.checked,
                                })
                              }
                            />
                            Blind Shadowing (Hide Text)
                          </label>
                          <div className="flex items-center gap-1">
                            <span className="text-[11px] font-bold text-slate-600">Speed:</span>
                            <select
                              value={b.speechSpeed ?? 1.0}
                              onChange={(e) =>
                                handleUpdateBlock(i, {
                                  speechSpeed: Number(e.target.value),
                                })
                              }
                              className="px-2 py-0.5 bg-white border border-slate-300 rounded text-xs font-mono"
                            >
                              <option value={0.85}>0.85x</option>
                              <option value={0.95}>0.95x</option>
                              <option value={1.0}>1.0x</option>
                              <option value={1.1}>1.1x</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => handleAddBlock('interactive-reading')}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg cursor-pointer"
            >
              + Append Another Block
            </button>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingTemplate(null)}
                className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const idToLaunch = editingTemplate.id;
                  await saveTemplate(editingTemplate);
                  handleLaunchTemplateInExam(idToLaunch);
                }}
                className="px-4 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer"
              >
                💾 Save & Launch Session Now
              </button>
              <button
                type="button"
                onClick={() => saveTemplate(editingTemplate)}
                className="px-5 py-2 bg-primary-600 text-white text-sm font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
              >
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
