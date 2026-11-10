// upgrade-v2-phase2-session-builder.mjs
// Run from project root: node upgrade-v2-phase2-session-builder.mjs
import fs from 'node:fs';
import path from 'node:path';

const files = {
  // =========================================================================
  // 1. TEMPLATE EDITOR: Full-Featured Session Architect + Blueprints + Pinning
  // =========================================================================
  'src/components/config/TemplateEditor.tsx': `import { useEffect } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { ensureDatabaseUpgraded } from '../../db/database';
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
      name: \`\${editingTemplate.blocks.length + 1}. \${option?.label.replace(/^[^\\s]+\\s/, '') ?? 'Practice Block'}\`,
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
      // If block type changed, auto-assign matching evaluation rubric
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
      name: \`\${source.name} (Copy)\`,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Session Architect & Practice Blueprints
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Design multi-block sessions with pinned YouTube clips/passages, exact second timers, custom rubrics, and 1-click launch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleCreatePresetBlueprint('full-det')}
            className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
          >
            ⚡ + Full DET Simulation Blueprint
          </button>
          <button
            type="button"
            onClick={() => handleCreatePresetBlueprint('audio-bootcamp')}
            className="px-3 py-2 bg-accent-600 text-white text-xs font-bold rounded-lg hover:bg-accent-700 cursor-pointer"
          >
            🎬 + YouTube Shadowing Bootcamp
          </button>
          <button
            type="button"
            onClick={createTemplate}
            className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
          >
            + Blank Custom Template
          </button>
        </div>
      </div>

      {/* =================================================================== */}
      {/* SAVED TEMPLATES LIST                                                */}
      {/* =================================================================== */}
      {!editingTemplate && (
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

          {/* Quick Add Block Palette */}
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

          {/* Block Cards */}
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
                  {/* Block Top Bar: Order Controls & Actions */}
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
                        title="Move Block Up"
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                      >
                        ↑ Up
                      </button>
                      <button
                        type="button"
                        disabled={i === editingTemplate.blocks.length - 1}
                        onClick={() => handleMoveBlock(i, 1)}
                        title="Move Block Down"
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

                  {/* Row 1: Name, Type, Exact Min/Sec Duration + Quick Presets */}
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
                            className={\`px-2 py-1 rounded text-[11px] font-mono font-bold border cursor-pointer \${
                              b.durationSec === p.sec
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                            }\`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Row 2: Pinned Question/Clip Selector, Subtype Filter, and AI Rubric */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-5">
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">
                        📌 Pin Specific Question / Passage / YouTube Clip ({eligibleQuestions.length} available)
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
                          🔄 Dynamic / Adaptive Selection (No single question pinned)
                        </option>
                        {eligibleQuestions.map((q) => (
                          <option key={q.id} value={q.id}>
                            [{q.type}] {q.sourceAttribution ? \`(\${q.sourceAttribution}) \` : ''}
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

                  {/* Row 3: Instructions & Per-Block Behavioral Toggles */}
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
`,

  // =========================================================================
  // 2. SHADOWING BLOCK: Respects Pinned Clip (questionSetId), Speed & Blind Mode
  // =========================================================================
  'src/components/exam/blocks/ShadowingBlock.tsx': `import { useState, useRef, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { AudioRecorderService } from '../../../services/audioRecorder';
import { createSTTProvider, analyzeSpeechTranscript } from '../../../services/stt';
import { db } from '../../../db/database';
import type { BlockConfig, QuestionBankItem } from '../../../types';
import { WhisperLiveIndicator } from '../../common/WhisperLiveIndicator';

const BACKEND_BASE = 'http://127.0.0.1:8000';

function normalizeAudioUrl(url?: string): string {
  if (!url) return '';
  return url.replace('http://127.0.0.1:8000/audio/', 'http://127.0.0.1:8000/clips/');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function computeWordMatchPercent(source: string, spoken: string): number {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, '')
      .split(/\\s+/)
      .filter(Boolean);
  const srcWords = clean(source);
  const spkSet = new Set(clean(spoken));
  if (srcWords.length === 0) return 0;
  const matched = srcWords.filter((w) => spkSet.has(w)).length;
  return Math.round((matched / srcWords.length) * 100);
}

export function ShadowingBlock({ block }: { block: BlockConfig }) {
  const draftResponses = useSessionStore((s) => s.draftResponses);
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const [passages, setPassages] = useState<QuestionBankItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [speechRate, setSpeechRate] = useState<number>(block.speechSpeed ?? 1.0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [hideTranscript, setHideTranscript] = useState<boolean>(Boolean(block.blindShadowing));
  const [downloadingYt, setDownloadingYt] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'transcribing' | 'done'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<AudioRecorderService | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordDurationRef = useRef<number>(0);

  const response = draftResponses[block.id];

  useEffect(() => {
    if (block.speechSpeed) setSpeechRate(block.speechSpeed);
    setHideTranscript(Boolean(block.blindShadowing));
  }, [block.id, block.speechSpeed, block.blindShadowing]);

  const loadShadowingPassages = useCallback(async () => {
    const all = await db.questionBank.toArray();
    let manifest: Record<string, { audioUrl: string; text: string }> = {};
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
      if (res.ok) {
        manifest = (await res.json()) as Record<string, { audioUrl: string; text: string }>;
      }
    } catch {
      // Backend offline or manifest empty
    }

    const updatedItems: QuestionBankItem[] = [];
    for (const q of all) {
      if (q.youtubeSource?.clipKey && manifest[q.youtubeSource.clipKey] && !q.audioUrl) {
        const cached = manifest[q.youtubeSource.clipKey];
        const upgraded: QuestionBankItem = {
          ...q,
          audioUrl: normalizeAudioUrl(cached.audioUrl),
          sourceAudioText: cached.text || q.sourceAudioText,
          prompt: cached.text || q.prompt,
        };
        await db.questionBank.put(upgraded);
        updatedItems.push(upgraded);
      } else {
        updatedItems.push({
          ...q,
          audioUrl: q.audioUrl ? normalizeAudioUrl(q.audioUrl) : q.audioUrl,
        });
      }
    }

    const shadowItems = updatedItems.filter(
      (q) =>
        Boolean(q.audioUrl) ||
        Boolean(q.youtubeSource) ||
        q.tags.includes('shadowing') ||
        q.type === 'read-aloud' ||
        Boolean(q.sourceAudioText)
    );
    shadowItems.sort(
      (a, b) =>
        (b.audioUrl ? 2 : b.youtubeSource ? 1 : 0) -
        (a.audioUrl ? 2 : a.youtubeSource ? 1 : 0)
    );
    const finalList = shadowItems.length > 0 ? shadowItems : updatedItems;
    setPassages(finalList);

    if (block.questionSetId) {
      const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
      if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
    }
  }, [block.questionSetId]);

  useEffect(() => {
    void loadShadowingPassages();
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, [loadShadowingPassages]);

  const currentItem = passages[selectedIdx];
  const humanAudioUrl = normalizeAudioUrl(currentItem?.audioUrl?.trim());
  const ytSource = currentItem?.youtubeSource;
  const sourceText =
    currentItem?.sourceAudioText ||
    currentItem?.prompt ||
    'While automated static analysis accelerates vulnerability discovery across large codebases, human security critics remain indispensable for verifying complex business logic and preventing subtle authentication bypasses.';

  useEffect(() => {
    const el = audioPlayerRef.current;
    if (!el) return;
    el.playbackRate = speechRate;
    if ('preservesPitch' in el) {
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }, [speechRate, humanAudioUrl]);

  const handleDownloadCuratedYoutube = async () => {
    if (!currentItem || !ytSource) return;
    setDownloadingYt(true);
    setError(null);
    try {
      const res = await fetch(\`\${BACKEND_BASE}/audio/youtube\`, {
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
        const errData = await res.json().catch(() => ({ detail: 'Download failed' }));
        throw new Error(errData.detail || 'yt-dlp download failed');
      }
      const data = (await res.json()) as {
        audioUrl: string;
        text: string;
      };
      const updatedItem: QuestionBankItem = {
        ...currentItem,
        audioUrl: normalizeAudioUrl(data.audioUrl),
        sourceAudioText: data.text || currentItem.sourceAudioText,
        prompt: data.text || currentItem.prompt,
      };
      await db.questionBank.put(updatedItem);
      setPassages((prev) =>
        prev.map((p, idx) => (idx === selectedIdx ? updatedItem : p))
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to download YouTube clip. Make sure python app.py is running and yt-dlp is installed.'
      );
    } finally {
      setDownloadingYt(false);
    }
  };

  const playNativeAudio = useCallback(() => {
    if (humanAudioUrl && audioPlayerRef.current) {
      audioPlayerRef.current.playbackRate = speechRate;
      audioPlayerRef.current.currentTime = 0;
      void audioPlayerRef.current.play();
      setIsPlayingAudio(true);
      return;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(sourceText);
      utterance.lang = 'en-US';
      utterance.rate = speechRate;
      utterance.onstart = () => setIsPlayingAudio(true);
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      window.speechSynthesis.speak(utterance);
    }
  }, [humanAudioUrl, sourceText, speechRate]);

  const stopNativeAudio = useCallback(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  }, []);

  const rewindFiveSeconds = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.currentTime = Math.max(0, audioPlayerRef.current.currentTime - 5);
    }
  };

  const handleStartShadowing = useCallback(async () => {
    setError(null);
    try {
      const recorder = new AudioRecorderService();
      const hasPermission = await recorder.requestPermission();
      if (!hasPermission) {
        setError('Microphone permission denied. Use headphones so your mic only captures your voice.');
        return;
      }
      await recorder.start();
      recorderRef.current = recorder;
      recordDurationRef.current = 0;
      setRecordingSeconds(0);
      setRecordingState('recording');
      playNativeAudio();
      recTimerRef.current = setInterval(() => {
        recordDurationRef.current += 1;
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start shadowing.');
    }
  }, [playNativeAudio]);

  const handleStopShadowing = useCallback(async () => {
    stopNativeAudio();
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording()) return;
    setRecordingState('transcribing');
    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      const dataUrl = await blobToDataUrl(blob);
      const settings = await db.settings.get('app-settings');
      const stt = createSTTProvider(settings?.sttProvider ?? 'local-whisper', {
        apiKey: settings?.sttApiKey,
        localWhisperUrl: settings?.localWhisperUrl,
      });
      const result = await stt.transcribe(blob, 'en');
      const actualDuration = result.durationSec ?? Math.max(5, recordDurationRef.current);
      const stats = analyzeSpeechTranscript(result.text, actualDuration);

      updateResponse(block.id, {
        audioBlobRef: dataUrl,
        textOrTranscript: result.text || '[No speech detected]',
        timestampedTranscript: result.timestampedText || result.text,
        audioDurationSec: actualDuration,
        promptSnapshot: sourceText,
        questionId: currentItem?.id,
        fillerCount: stats.fillerCount,
        wpm: stats.wpm,
      });
      setRecordingState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Shadowing transcription failed');
      setRecordingState('idle');
    }
  }, [block.id, currentItem?.id, sourceText, stopNativeAudio, updateResponse]);

  const matchPercent = computeWordMatchPercent(sourceText, response?.textOrTranscript ?? '');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <WhisperLiveIndicator />
          <span
            className={\`text-xs font-bold px-2.5 py-1 rounded-full \${
              humanAudioUrl
                ? 'bg-green-100 text-green-800 border border-green-300'
                : ytSource
                ? 'bg-blue-100 text-blue-800 border border-blue-300'
                : 'bg-amber-100 text-amber-800'
            }\`}
          >
            {humanAudioUrl
              ? '🎙️ Real Human Audio Ready on Device'
              : ytSource
              ? \`🎬 Curated YouTube Talk: \${ytSource.speaker}\`
              : '⚠️ Synthetic TTS Fallback'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs font-semibold text-slate-600">Speed:</label>
          {[0.85, 0.95, 1.0, 1.1].map((rate) => (
            <button
              key={rate}
              type="button"
              onClick={() => setSpeechRate(rate)}
              className={\`px-2 py-1 text-xs rounded-lg font-mono font-semibold border cursor-pointer \${
                speechRate === rate
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'bg-white text-slate-700 border-slate-200'
              }\`}
            >
              {rate}x
            </button>
          ))}
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                stopNativeAudio();
                setSelectedIdx(Number(e.target.value));
              }}
              className="text-xs font-semibold text-primary-800 bg-primary-50 border border-primary-200 px-2.5 py-1 rounded-lg cursor-pointer max-w-[220px]"
            >
              {passages.map((p, idx) => (
                <option key={p.id} value={idx}>
                  #{idx + 1} {p.sourceAttribution || p.prompt.slice(0, 35)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {!humanAudioUrl && ytSource && (
        <div className="bg-accent-50 border-2 border-accent-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-accent-800">
              🎬 Curated TED / Academic Talk Linked ({ytSource.speaker} • {ytSource.startTime}–{ytSource.endTime})
            </p>
            <p className="text-xs text-slate-600 mt-0.5">
              Click once to auto-download this real human audio slice to your device and transcribe it with Faster-Whisper.
            </p>
          </div>
          <button
            type="button"
            disabled={downloadingYt}
            onClick={handleDownloadCuratedYoutube}
            className="px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold rounded-lg disabled:opacity-50 cursor-pointer shadow-xs"
          >
            {downloadingYt
              ? '⏳ Downloading & Transcribing via GPU...'
              : '⬇️ Auto-Download Human Audio to Device'}
          </button>
        </div>
      )}

      {humanAudioUrl && (
        <div className="bg-slate-900 text-white rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>
              Human Reference Track ({currentItem?.sourceAttribution || 'Local MP3'} • Pitch-Preserved {speechRate}x)
            </span>
            <button
              type="button"
              onClick={rewindFiveSeconds}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded font-mono text-xs cursor-pointer"
            >
              ↺ Rewind -5s
            </button>
          </div>
          <audio
            ref={audioPlayerRef}
            controls
            src={humanAudioUrl}
            onPlay={() => setIsPlayingAudio(true)}
            onPause={() => setIsPlayingAudio(false)}
            onEnded={() => setIsPlayingAudio(false)}
            className="w-full h-10"
          />
        </div>
      )}

      <div className="bg-primary-50 border border-primary-200 rounded-xl p-5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-primary-700">
            Arguelles Shadowing Script ({currentItem?.sourceAttribution || 'Academic Passage'})
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHideTranscript((h) => !h)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-slate-700 cursor-pointer"
            >
              {hideTranscript ? 'Show Transcript' : 'Blind Shadowing (Hide Text)'}
            </button>
            {!humanAudioUrl && (
              <button
                type="button"
                onClick={isPlayingAudio ? stopNativeAudio : playNativeAudio}
                className="text-xs font-semibold px-3 py-1 rounded-lg bg-white border border-primary-300 text-primary-800"
              >
                {isPlayingAudio ? 'Stop Audio' : 'Preview Audio'}
              </button>
            )}
          </div>
        </div>
        {hideTranscript ? (
          <p className="text-sm italic text-slate-500 py-4 text-center">
            Transcript hidden for pure auditory-motor shadowing. Listen closely to the human speaker's intonation!
          </p>
        ) : (
          <p className="text-base text-slate-900 leading-relaxed font-medium">{sourceText}</p>
        )}
      </div>

      <div className="flex justify-center">
        {recordingState !== 'recording' && recordingState !== 'transcribing' && (
          <button
            type="button"
            onClick={handleStartShadowing}
            className="px-7 py-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-lg cursor-pointer flex items-center gap-3"
          >
            <span className="w-3 h-3 rounded-full bg-white animate-ping" />
            Play Human Audio & Record Your Shadowing Simultaneously
          </button>
        )}
        {recordingState === 'recording' && (
          <button
            type="button"
            onClick={handleStopShadowing}
            className="px-7 py-4 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm shadow-lg cursor-pointer"
          >
            Stop & Transcribe Shadowing ({recordingSeconds}s)
          </button>
        )}
      </div>

      {recordingState === 'transcribing' && (
        <div className="bg-accent-50 border border-accent-200 rounded-xl p-5 text-center text-sm font-semibold text-accent-800">
          Transcribing shadowed speech & computing prosody alignment via Faster-Whisper...
        </div>
      )}

      {response?.textOrTranscript && recordingState !== 'recording' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Lexical Capture</p>
              <p className="text-lg font-bold text-primary-600">{matchPercent}% matched</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Shadowing Pace</p>
              <p className="text-lg font-bold text-slate-800">{response.wpm ?? 0} WPM</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
              <p className="text-xs text-slate-500">Spoken Duration</p>
              <p className="text-lg font-bold text-slate-800">
                {response.audioDurationSec ?? recordingSeconds}s
              </p>
            </div>
          </div>

          {response.audioBlobRef && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">Your Recorded Shadowing:</p>
              <audio controls src={response.audioBlobRef} className="w-full h-9" />
            </div>
          )}

          {response.timestampedTranscript && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-1">
                Timestamped Shadowing Output (Sent to Gemini):
              </p>
              <pre className="text-xs font-mono bg-slate-900 text-green-300 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                {response.timestampedTranscript}
              </pre>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 3. DICTOGLOSS BLOCK: Respects Pinned Clip (questionSetId) & /clips/ URL
  // =========================================================================
  'src/components/exam/blocks/DictoglossBlock.tsx': `import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db } from '../../../db/database';
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
      const all = await db.questionBank.toArray();
      let manifest: Record<string, { audioUrl: string; text: string }> = {};
      try {
        const res = await fetch(\`\${BACKEND_BASE}/audio/manifest\`);
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
      items.sort((a, b) => (b.audioUrl ? 1 : 0) - (a.audioUrl ? 1 : 0));
      const finalList = items.length > 0 ? items : hydrated;
      setPassages(finalList);

      if (block.questionSetId) {
        const pinnedIdx = finalList.findIndex((q) => q.id === block.questionSetId);
        if (pinnedIdx >= 0) setSelectedIdx(pinnedIdx);
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
    const words = val.trim().split(/\\s+/).filter(Boolean);
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

  const fragmentWordCount = fragmentNotes.trim() ? fragmentNotes.trim().split(/\\s+/).length : 0;

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
        <div className="flex items-center gap-2">
          {passages.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => {
                setPlayCount(0);
                setSelectedIdx(Number(e.target.value));
              }}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg cursor-pointer max-w-[200px]"
            >
              {passages.map((p, idx) => (
                <option key={p.id} value={idx}>
                  #{idx + 1} {p.sourceAttribution || p.prompt.slice(0, 32)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setPhase('listen')}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'listen' ? 'bg-accent-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
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
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer \${
              phase === 'reconstruct' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }\`}
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
            onChange={(e) =>
              updateResponse(block.id, {
                textOrTranscript: e.target.value,
                promptSnapshot: sourcePassage,
                questionId: currentItem?.id,
              })
            }
            placeholder="Reconstruct the passage's full meaning using complex subordination (whereas, consequently, while) and academic collocations..."
            className="w-full min-h-[240px] p-4 text-base text-slate-800 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400"
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
`,

  // =========================================================================
  // 4. INTERACTIVE READING BLOCK: Respects Pinned Passage & Sub-Type Filter
  // =========================================================================
  'src/components/exam/blocks/InteractiveReadingBlock.tsx': `import { useState, useEffect, useMemo, useRef, type KeyboardEvent, type ChangeEvent } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { db, ensureDatabaseUpgraded } from '../../../db/database';
import type { BlockConfig, QuestionBankItem, ReadAndCompleteBlank } from '../../../types';

const STEP_LABELS = [
  '1. Complete the Sentences',
  '2. Complete the Passage',
  '3. Highlight the Answer #1',
  '4. Highlight the Answer #2',
  '5. Identify the Idea',
  '6. Title the Passage',
];

function SegmentedWordBlank({
  blank,
  value,
  submitted,
  onChange,
}: {
  blank: ReadAndCompleteBlank;
  value: string;
  submitted: boolean;
  onChange: (newVal: string) => void;
}) {
  const len = blank.missingSuffix.length;
  const boxRefs = useRef<(HTMLInputElement | null)[]>([]);

  const chars = Array.from({ length: len }, (_, i) => value[i] ?? '');
  const isCorrect =
    submitted && value.trim().toLowerCase() === blank.missingSuffix.toLowerCase();
  const isWrong =
    submitted && value.trim().toLowerCase() !== blank.missingSuffix.toLowerCase();

  const updateCharAt = (index: number, char: string) => {
    const next = [...chars];
    next[index] = char;
    onChange(next.join(''));
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (chars[index]) {
        updateCharAt(index, '');
      } else if (index > 0) {
        updateCharAt(index - 1, '');
        boxRefs.current[index - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      boxRefs.current[index - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && index < len - 1) {
      e.preventDefault();
      boxRefs.current[index + 1]?.focus();
      return;
    }
  };

  const handleInput = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (!raw) {
      updateCharAt(index, '');
      return;
    }
    const clean = raw.replace(/[^a-zA-Z-]/g, '');
    if (!clean) return;

    if (clean.length === 1) {
      updateCharAt(index, clean);
      if (index < len - 1) {
        boxRefs.current[index + 1]?.focus();
      }
    } else {
      const next = [...chars];
      for (let i = 0; i < clean.length && index + i < len; i++) {
        next[index + i] = clean[i];
      }
      onChange(next.join(''));
      const nextFocus = Math.min(len - 1, index + clean.length);
      boxRefs.current[nextFocus]?.focus();
    }
  };

  return (
    <span className="inline-flex items-center mx-1 my-0.5 align-baseline">
      <span className="font-bold text-slate-900 font-mono text-base px-1 py-0.5 bg-slate-200/80 rounded-l-md border border-r-0 border-slate-300">
        {blank.prefix}
      </span>

      <span className="inline-flex items-center">
        {chars.map((ch, i) => (
          <input
            key={i}
            ref={(el) => {
              boxRefs.current[i] = el;
            }}
            type="text"
            inputMode="text"
            maxLength={2}
            value={ch}
            onChange={(e) => handleInput(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={\`\${blank.prefix} letter \${i + 1} of \${len}\`}
            className={\`w-6 h-7 text-center font-mono text-sm font-bold border border-r-0 last:border-r last:rounded-r-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:z-10 transition-colors \${
              isCorrect
                ? 'bg-green-100 border-green-500 text-green-900'
                : isWrong
                ? 'bg-red-50 border-red-400 text-red-800'
                : ch
                ? 'bg-primary-50 border-primary-400 text-primary-900'
                : 'bg-white border-slate-300 text-slate-800'
            }\`}
          />
        ))}
      </span>

      {isWrong && (
        <span className="ml-1.5 text-xs font-mono font-bold text-green-800 bg-green-100 px-1.5 py-0.5 rounded">
          ✓ {blank.fullWord}
        </span>
      )}
    </span>
  );
}

export function InteractiveReadingBlock({
  block,
  forcedMode,
}: {
  block: BlockConfig;
  forcedMode?: 'interactive-reading' | 'read-and-complete';
}) {
  const updateResponse = useSessionStore((s) => s.updateResponse);

  const initialMode: 'interactive-reading' | 'read-and-complete' =
    forcedMode ??
    (block.preferredQuestionType === 'interactive-reading'
      ? 'interactive-reading'
      : 'read-and-complete');

  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [mode, setMode] = useState<'interactive-reading' | 'read-and-complete'>(initialMode);
  const [currentIdx, setCurrentIdx] = useState(0);

  const [step, setStep] = useState(0);
  const [clozeAnswers, setClozeAnswers] = useState<Record<string, string>>({});
  const [selectedGapSentence, setSelectedGapSentence] = useState<string>('');
  const [highlighted1, setHighlighted1] = useState<string>('');
  const [highlighted2, setHighlighted2] = useState<string>('');
  const [selectedIdea, setSelectedIdea] = useState<string>('');
  const [selectedTitle, setSelectedTitle] = useState<string>('');
  const [submittedReading, setSubmittedReading] = useState(false);

  const [prefixInputs, setPrefixInputs] = useState<Record<string, string>>({});
  const [submittedCloze, setSubmittedCloze] = useState(false);
  const [lastClozeScore, setLastClozeScore] = useState<{
    earned: number;
    total: number;
    detScore: number;
  } | null>(null);

  useEffect(() => {
    if (forcedMode) {
      setMode(forcedMode);
    } else if (
      block.preferredQuestionType === 'interactive-reading' ||
      block.preferredQuestionType === 'read-and-complete'
    ) {
      setMode(block.preferredQuestionType);
    }
  }, [forcedMode, block.preferredQuestionType]);

  useEffect(() => {
    ensureDatabaseUpgraded()
      .then(() => db.questionBank.toArray())
      .then((all) => {
        const readingItems = all.filter(
          (q) =>
            q.skill === 'reading' &&
            (q.type === 'interactive-reading' || q.type === 'read-and-complete')
        );
        setQuestions(readingItems);

        if (block.questionSetId) {
          const pinned = readingItems.find((q) => q.id === block.questionSetId);
          if (pinned && (pinned.type === 'read-and-complete' || pinned.type === 'interactive-reading')) {
            setMode(pinned.type);
            const subset = readingItems.filter((q) => q.type === pinned.type);
            const idx = subset.findIndex((q) => q.id === pinned.id);
            if (idx >= 0) setCurrentIdx(idx);
          }
        }
      });
  }, [block.questionSetId]);

  const filteredList = useMemo(
    () => questions.filter((q) => q.type === mode),
    [questions, mode]
  );

  const activeItem = filteredList[currentIdx] ?? null;
  const ir = activeItem?.interactiveReading;
  const rc = activeItem?.readAndComplete;

  const resetStates = () => {
    setStep(0);
    setClozeAnswers({});
    setSelectedGapSentence('');
    setHighlighted1('');
    setHighlighted2('');
    setSelectedIdea('');
    setSelectedTitle('');
    setSubmittedReading(false);
    setPrefixInputs({});
    setSubmittedCloze(false);
    setLastClozeScore(null);
  };

  const handleSwitchPassage = (nextIndex: number) => {
    setCurrentIdx(nextIndex);
    resetStates();
  };

  const handleGradeInteractiveReading = () => {
    if (!ir || !activeItem) return;
    let earned = 0;
    const totalPossible = ir.blanks.length + 5;
    const wrongDetails: string[] = [];
    const rightDetails: string[] = [];

    for (const b of ir.blanks) {
      if (clozeAnswers[b.id] === b.correctAnswer) {
        earned += 1;
      } else {
        wrongDetails.push(
          \`Blank [\${b.id}]: chose "\${clozeAnswers[b.id] || 'none'}" (Correct: "\${b.correctAnswer}")\`
        );
      }
    }
    if (earned === ir.blanks.length) {
      rightDetails.push('Perfect lexical precision on Complete the Sentences.');
    }

    if (selectedGapSentence === ir.correctPassageGap) {
      earned += 1;
      rightDetails.push('Correctly bridged discourse transition in Complete the Passage.');
    } else {
      wrongDetails.push('Missed discourse transition sentence in Step 2 (Complete the Passage).');
    }

    if (highlighted1.trim() === ir.correctHighlight1.trim()) {
      earned += 1;
      rightDetails.push('Pinpointed exact factual evidence in Highlight the Answer #1.');
    } else {
      wrongDetails.push('Inaccurate sentence selection on Highlight the Answer #1.');
    }

    if (highlighted2.trim() === ir.correctHighlight2.trim()) {
      earned += 1;
      rightDetails.push('Pinpointed exact factual evidence in Highlight the Answer #2.');
    } else {
      wrongDetails.push('Inaccurate sentence selection on Highlight the Answer #2.');
    }

    if (selectedIdea === ir.correctMainIdea) {
      earned += 1;
      rightDetails.push('Identified primary macro-thesis of the passage.');
    } else {
      wrongDetails.push('Missed main idea synthesis in Identify the Idea.');
    }

    if (selectedTitle === ir.correctTitle) {
      earned += 1;
    } else {
      wrongDetails.push('Selected suboptimal academic title.');
    }

    const accuracy = earned / Math.max(1, totalPossible);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedReading(true);

    const summaryTranscript = [
      \`[Interactive Reading — \${ir.sourceName}]\`,
      \`Accuracy: \${earned}/\${totalPossible} (\${Math.round(accuracy * 100)}%) -> Estimated DET Band: \${detScore}/160\`,
      wrongDetails.length > 0
        ? \`Mistakes: \${wrongDetails.join(' | ')}\`
        : 'Zero errors across all 6 steps!',
    ].join('\\n');

    updateResponse(block.id, {
      questionId: activeItem.id,
      questionType: 'interactive-reading',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
        conversation: Math.max(65, detScore - 5),
        production: Math.max(65, detScore - 5),
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: { literacy: detScore, comprehension: detScore },
        criteria: {
          reading_accuracy: \`\${earned} / \${totalPossible} items correct\`,
          source: ir.sourceName,
        },
        strengths:
          rightDetails.length > 0 ? rightDetails : ['Completed interactive reading passage'],
        weaknesses: wrongDetails,
        suggestions: [
          'Pay close attention to discourse markers (however, consequently, whereas) when bridging paragraphs.',
        ],
      },
    });
  };

  const handleGradeReadAndComplete = () => {
    if (!rc || !activeItem) return;
    let earned = 0;
    const total = rc.blanks.length;
    const missedWords: string[] = [];

    for (const b of rc.blanks) {
      const userSuffix = (prefixInputs[b.id] ?? '').trim().toLowerCase();
      if (userSuffix === b.missingSuffix.toLowerCase()) {
        earned += 1;
      } else {
        missedWords.push(\`\${b.prefix}[\${b.missingSuffix}] (you typed: "\${b.prefix}\${userSuffix}")\`);
      }
    }

    const accuracy = earned / Math.max(1, total);
    const detScore = Math.round(70 + accuracy * 90);
    setSubmittedCloze(true);
    setLastClozeScore({ earned, total, detScore });

    const summaryTranscript = \`[Read and Complete — \${rc.sourceName}] Score: \${earned}/\${total} (\${detScore}/160). \${
      missedWords.length > 0
        ? 'Missed: ' + missedWords.join(', ')
        : 'All words completed accurately!'
    }\`;

    updateResponse(block.id, {
      questionId: activeItem.id,
      questionType: 'read-and-complete',
      promptSnapshot: activeItem.prompt,
      textOrTranscript: summaryTranscript,
      aiOverallScore: detScore,
      aiSubscores: {
        literacy: detScore,
        comprehension: detScore,
      },
      aiFeedback: {
        overallScore: detScore,
        subscores: { literacy: detScore, comprehension: detScore },
        criteria: { lexical_cloze: \`\${earned}/\${total} correct\` },
        strengths:
          earned >= total - 2
            ? ['Strong orthographic & collocation recall']
            : ['Completed C-test passage'],
        weaknesses: missedWords,
        suggestions: [
          'Look at grammatical suffixes (-tion, -ive, -ly) and exact letter box counts.',
        ],
      },
    });
  };

  const renderParagraphWithDropdowns = () => {
    if (!ir) return null;
    const parts = ir.paragraph1WithBlanks.split(/(\\{\\{\\d+\\}\\})/g);
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-8">
        {parts.map((part, i) => {
          const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
          if (!match) return <span key={i}>{part}</span>;
          const blankId = match[1];
          const blankObj = ir.blanks.find((b) => b.id === blankId);
          if (!blankObj) return <span key={i}>{part}</span>;
          const val = clozeAnswers[blankId] ?? '';
          const isCorrect = submittedReading && val === blankObj.correctAnswer;
          const isWrong = submittedReading && val !== blankObj.correctAnswer;
          return (
            <span key={i} className="inline-block mx-1">
              <select
                value={val}
                onChange={(e) =>
                  setClozeAnswers((prev) => ({ ...prev, [blankId]: e.target.value }))
                }
                className={\`px-2.5 py-1 text-sm font-bold rounded-lg border-2 transition-colors cursor-pointer \${
                  isCorrect
                    ? 'bg-green-100 border-green-500 text-green-900'
                    : isWrong
                    ? 'bg-red-100 border-red-500 text-red-900'
                    : val
                    ? 'bg-primary-50 border-primary-500 text-primary-900'
                    : 'bg-amber-50 border-amber-300 text-slate-700'
                }\`}
              >
                <option value="">[{blankId}] Select word...</option>
                {blankObj.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {isWrong && (
                <span className="ml-1 text-xs font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                  ✓ {blankObj.correctAnswer}
                </span>
              )}
            </span>
          );
        })}
      </p>
    );
  };

  const renderClickableSentences = (sentences: string[], isHighlightStep: boolean) => {
    const activeSelection = step === 2 ? highlighted1 : step === 3 ? highlighted2 : '';
    return (
      <p className="text-sm sm:text-base text-slate-800 leading-7">
        {sentences.map((sentence, idx) => {
          const isSelected = activeSelection.trim() === sentence.trim();
          return (
            <span
              key={idx}
              onClick={() => {
                if (!isHighlightStep) return;
                if (step === 2) setHighlighted1(sentence);
                if (step === 3) setHighlighted2(sentence);
              }}
              className={\`inline transition-colors rounded px-1 py-0.5 \${
                isHighlightStep
                  ? isSelected
                    ? 'bg-amber-200 text-slate-900 font-semibold ring-2 ring-amber-400 cursor-pointer'
                    : 'hover:bg-primary-100 cursor-pointer'
                  : ''
              }\`}
            >
              {sentence}{' '}
            </span>
          );
        })}
      </p>
    );
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('read-and-complete');
              setCurrentIdx(0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'read-and-complete'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            ✍️ Read and Complete ({questions.filter((q) => q.type === 'read-and-complete').length} Passages)
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('interactive-reading');
              setCurrentIdx(0);
              resetStates();
            }}
            className={\`px-3 py-1.5 text-xs font-bold rounded-lg cursor-pointer transition-colors \${
              mode === 'interactive-reading'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }\`}
          >
            📖 Interactive Reading ({questions.filter((q) => q.type === 'interactive-reading').length} Suites)
          </button>
        </div>

        {filteredList.length > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                handleSwitchPassage((currentIdx - 1 + filteredList.length) % filteredList.length)
              }
              className="px-2.5 py-1 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              ← Prev
            </button>
            <select
              value={currentIdx}
              onChange={(e) => handleSwitchPassage(Number(e.target.value))}
              className="text-xs font-semibold text-slate-800 border border-slate-200 rounded-lg px-2 py-1"
            >
              {filteredList.map((item, idx) => (
                <option key={item.id} value={idx}>
                  Passage {idx + 1}: {item.readAndComplete?.title || item.prompt.slice(0, 42)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => handleSwitchPassage((currentIdx + 1) % filteredList.length)}
              className="px-2.5 py-1 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {mode === 'read-and-complete' && rc && (
        <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 space-y-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                Type the missing letters • Source: {rc.sourceName}
              </span>
              <h3 className="text-lg font-bold text-slate-900 mt-1.5">{rc.title}</h3>
            </div>

            <div className="flex items-center gap-2">
              {lastClozeScore && (
                <span className="text-xs font-bold bg-green-100 text-green-800 border border-green-300 px-3 py-1.5 rounded-lg">
                  Score: {lastClozeScore.earned}/{lastClozeScore.total} • Band {lastClozeScore.detScore}/160
                </span>
              )}
              <button
                type="button"
                onClick={handleGradeReadAndComplete}
                className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer shadow-2xs"
              >
                ✓ Check Answers
              </button>
              {submittedCloze && filteredList.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleSwitchPassage((currentIdx + 1) % filteredList.length)}
                  className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Next Paragraph ({((currentIdx + 1) % filteredList.length) + 1}/{filteredList.length}) →
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Each small box represents <strong>one missing letter</strong>. Typing a letter automatically moves to the next box (use Backspace to go back):
          </p>

          <div className="text-base text-slate-800 leading-10 bg-slate-50 p-6 rounded-xl border border-slate-200">
            {rc.passageWithBlanks.split(/(\\{\\{\\d+\\}\\})/g).map((part, idx) => {
              const match = part.match(/^\\{\\{(\\d+)\\}\\}$/);
              if (!match) return <span key={idx}>{part}</span>;
              const bId = match[1];
              const blank = rc.blanks.find((b) => b.id === bId);
              if (!blank) return <span key={idx}>{part}</span>;

              return (
                <SegmentedWordBlank
                  key={bId}
                  blank={blank}
                  value={prefixInputs[bId] ?? ''}
                  submitted={submittedCloze}
                  onChange={(newVal) =>
                    setPrefixInputs((prev) => ({ ...prev, [bId]: newVal }))
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      {mode === 'interactive-reading' && ir && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {STEP_LABELS.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => setStep(idx)}
                className={\`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all cursor-pointer \${
                  step === idx
                    ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }\`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border-2 border-slate-200 rounded-2xl p-5 space-y-4 shadow-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span className="text-xs font-bold uppercase tracking-wider text-primary-700 bg-primary-50 px-2.5 py-1 rounded">
                  Source: {ir.sourceName}
                </span>
                {(step === 2 || step === 3) && (
                  <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2.5 py-1 rounded animate-pulse">
                    Click a sentence below to highlight your answer
                  </span>
                )}
              </div>

              {step === 0
                ? renderParagraphWithDropdowns()
                : renderClickableSentences(ir.paragraph1Sentences, step === 2 || step === 3)}

              {step >= 1 && (
                <div
                  className={\`p-3 rounded-xl border-2 text-sm font-medium transition-all \${
                    selectedGapSentence
                      ? submittedReading
                        ? selectedGapSentence === ir.correctPassageGap
                          ? 'bg-green-50 border-green-400 text-green-900'
                          : 'bg-red-50 border-red-400 text-red-900'
                        : 'bg-primary-50 border-primary-400 text-slate-900'
                      : 'bg-amber-50/70 border-dashed border-amber-400 text-amber-800 italic'
                  }\`}
                >
                  {selectedGapSentence ||
                    '[Step 2 Gap: Select the best transitional sentence on the right to bridge these two paragraphs...]'}
                </div>
              )}

              {step >= 1 &&
                renderClickableSentences(ir.paragraph2Sentences, step === 2 || step === 3)}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between space-y-4 shadow-xs">
              <div className="space-y-4">
                <span className="text-xs font-bold uppercase tracking-wider text-accent-700 bg-accent-50 px-2.5 py-1 rounded">
                  {STEP_LABELS[step]}
                </span>

                {step === 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best word for each blank in the passage on the left.
                    </h4>
                    <div className="space-y-2 pt-2">
                      {ir.blanks.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between text-xs bg-slate-50 p-2.5 rounded-lg border border-slate-200"
                        >
                          <span className="font-bold text-slate-700">Blank [{b.id}]:</span>
                          <span className="font-semibold text-primary-700">
                            {clozeAnswers[b.id] || 'Not selected yet'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {step === 1 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best sentence to fill in the blank between the two paragraphs.
                    </h4>
                    <div className="space-y-2">
                      {ir.passageGapOptions.map((opt) => {
                        const chosen = selectedGapSentence === opt;
                        const isRight = submittedReading && opt === ir.correctPassageGap;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedGapSentence(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the question below:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion1}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted1 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted1.trim() !== ir.correctHighlight1.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight1}
                      </div>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Click a sentence in the passage to answer the second question:
                    </h4>
                    <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-semibold leading-relaxed">
                      {ir.highlightQuestion2}
                    </div>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-slate-800">
                      <strong>Your Highlighted Sentence:</strong>
                      <p className="mt-1 italic">
                        {highlighted2 || '(Click directly on any sentence in the left passage)'}
                      </p>
                    </div>
                    {submittedReading && highlighted2.trim() !== ir.correctHighlight2.trim() && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-900">
                        <strong>✓ Correct Sentence:</strong> {ir.correctHighlight2}
                      </div>
                    )}
                  </div>
                )}

                {step === 4 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the idea that is expressed in the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.mainIdeaOptions.map((opt) => {
                        const chosen = selectedIdea === opt;
                        const isRight = submittedReading && opt === ir.correctMainIdea;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedIdea(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {step === 5 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900">
                      Select the best title for the passage:
                    </h4>
                    <div className="space-y-2">
                      {ir.titleOptions.map((opt) => {
                        const chosen = selectedTitle === opt;
                        const isRight = submittedReading && opt === ir.correctTitle;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setSelectedTitle(opt)}
                            className={\`w-full text-left p-3 rounded-xl border-2 text-xs leading-relaxed transition-all cursor-pointer \${
                              isRight
                                ? 'border-green-500 bg-green-50 font-bold text-green-900'
                                : chosen
                                ? 'border-primary-500 bg-primary-50 font-semibold text-slate-900'
                                : 'border-slate-200 hover:border-slate-300 text-slate-700'
                            }\`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
                <button
                  type="button"
                  disabled={step === 0}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg disabled:opacity-40 cursor-pointer"
                >
                  ← Previous Step
                </button>
                {step < 5 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => Math.min(5, s + 1))}
                    className="px-4 py-2 bg-primary-600 text-white text-xs font-bold rounded-lg hover:bg-primary-700 cursor-pointer"
                  >
                    Next Step ({step + 2}/6) →
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGradeInteractiveReading}
                    className="px-5 py-2 bg-green-600 text-white text-xs font-bold rounded-lg hover:bg-green-700 cursor-pointer shadow-xs"
                  >
                    ✓ Check All 6 Answers & Score
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
`,
};

const cwd = process.cwd();
for (const [relPath, content] of Object.entries(files)) {
  const targetPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('Phase 2 v2 Updated:', path.relative(cwd, targetPath));
}
console.log('\nPhase 2 v2 (Advanced Session Architect + Block Pinning) applied successfully!');