import { useEffect } from 'react';
import { useConfigStore } from '../../stores/configStore';
import { ensureDatabaseUpgraded } from '../../db/database';
import type { Block, BlockType } from '../../types';
import { formatTime, generateId } from '../../utils/helpers';

const BLOCK_TYPE_OPTIONS: { value: BlockType; label: string }[] = [
  { value: 'interactive-reading', label: '📖 Interactive Reading & Read/Complete' },
  { value: 'shadowing', label: '🗣️ Arguelles Shadowing (TED / Human Audio)' },
  { value: 'dictogloss', label: '🎧 Dictogloss Working-Memory Reconstruction' },
  { value: 'vocab-writing', label: '🧩 Collocation Chunk Writing (SRS)' },
  { value: 'speaking', label: '🎙️ Timed Verbatim Speaking' },
  { value: 'brain-dump', label: '📝 Brain Dump & Structural Outline' },
  { value: 'mock-test', label: '🎯 Timed Adaptive Mock Test' },
  { value: 'custom', label: '⚙️ Custom Block' },
];

export function TemplateEditor() {
  const templates = useConfigStore((s) => s.templates);
  const loadTemplates = useConfigStore((s) => s.loadTemplates);
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const editingTemplate = useConfigStore((s) => s.editingTemplate);
  const setEditingTemplate = useConfigStore((s) => s.setEditingTemplate);
  const createTemplate = useConfigStore((s) => s.createTemplate);
  const saveTemplate = useConfigStore((s) => s.saveTemplate);
  const deleteTemplate = useConfigStore((s) => s.deleteTemplate);
  const duplicateTemplate = useConfigStore((s) => s.duplicateTemplate);

  useEffect(() => {
    void ensureDatabaseUpgraded().then(() => loadTemplates());
  }, [loadTemplates]);

  const handleAddBlock = () => {
    if (!editingTemplate) return;
    const defaultEval = evalPrompts[0]?.id ?? '';
    const newBlock: Block = {
      id: generateId(),
      name: `Block ${editingTemplate.blocks.length + 1}`,
      type: 'interactive-reading',
      durationSec: 5 * 60,
      instructions: 'Complete the task below under timed conditions.',
      autoAdvance: false,
      evalPromptId: defaultEval,
    };
    setEditingTemplate({
      ...editingTemplate,
      blocks: [...editingTemplate.blocks, newBlock],
    });
  };

  const handleUpdateBlock = (index: number, patch: Partial<Block>) => {
    if (!editingTemplate) return;
    const nextBlocks = editingTemplate.blocks.map((b, i) =>
      i === index ? { ...b, ...patch } : b
    );
    setEditingTemplate({ ...editingTemplate, blocks: nextBlocks });
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Session Templates</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Build custom practice routines combining Reading, Shadowing, Dictogloss, Writing, and Speaking blocks.
          </p>
        </div>
        <button
          onClick={createTemplate}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 cursor-pointer"
        >
          + New Template
        </button>
      </div>

      {!editingTemplate && (
        <div className="space-y-3">
          {templates.map((t) => {
            const totalDuration = t.blocks.reduce((sum, b) => sum + b.durationSec, 0);
            return (
              <div
                key={t.id}
                className="bg-white rounded-xl border border-slate-200 p-5 hover:border-primary-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-slate-900">{t.name}</h3>
                    {t.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{t.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <span className="text-xs font-mono text-slate-500">
                        Total: {formatTime(totalDuration)}
                      </span>
                      {t.blocks.map((b, idx) => (
                        <span
                          key={b.id}
                          className="text-xs bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-full font-medium"
                        >
                          {idx + 1}. {b.name} ({Math.round(b.durationSec / 60)}m)
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setEditingTemplate({ ...t })}
                      className="px-3 py-1.5 text-xs font-semibold text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => duplicateTemplate(t.id)}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      className="px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
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

      {editingTemplate && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
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
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Description
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

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Blocks ({editingTemplate.blocks.length})
              </h4>
              <button
                type="button"
                onClick={handleAddBlock}
                className="px-3 py-1.5 bg-accent-600 text-white text-xs font-bold rounded-lg hover:bg-accent-700 cursor-pointer"
              >
                + Add Block
              </button>
            </div>

            {editingTemplate.blocks.map((b, i) => (
              <div
                key={b.id}
                className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3"
              >
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Block Name
                    </label>
                    <input
                      type="text"
                      value={b.name}
                      onChange={(e) => handleUpdateBlock(i, { name: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Block Type
                    </label>
                    <select
                      value={b.type}
                      onChange={(e) =>
                        handleUpdateBlock(i, { type: e.target.value as BlockType })
                      }
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                    >
                      {BLOCK_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      Duration (Minutes)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={Math.max(1, Math.round(b.durationSec / 60))}
                      onChange={(e) =>
                        handleUpdateBlock(i, {
                          durationSec: Math.max(1, Number(e.target.value)) * 60,
                        })
                      }
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <input
                    type="text"
                    value={b.instructions}
                    onChange={(e) =>
                      handleUpdateBlock(i, { instructions: e.target.value })
                    }
                    placeholder="Instructions for this block..."
                    className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveBlock(i)}
                    className="px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 rounded cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setEditingTemplate(null)}
              className="px-4 py-2 text-sm text-slate-600 cursor-pointer"
            >
              Cancel
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
      )}
    </div>
  );
}
