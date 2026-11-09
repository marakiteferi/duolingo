import { useState } from 'react';
import { useConfigStore } from '../../stores/configStore';
import type { EvalPrompt, BlockType, ScoreScale } from '../../types';
import { generateId } from '../../utils/helpers';

export function EvalPromptEditor() {
  const evalPrompts = useConfigStore((s) => s.evalPrompts);
  const saveEvalPrompt = useConfigStore((s) => s.saveEvalPrompt);
  const deleteEvalPrompt = useConfigStore((s) => s.deleteEvalPrompt);
  const [editing, setEditing] = useState<EvalPrompt | null>(null);

  const blockTypes: { value: BlockType; label: string }[] = [
    { value: 'brain-dump', label: 'Brain Dump' },
    { value: 'vocab-writing', label: 'Collocation Chunk Writing' },
    { value: 'speaking', label: 'Timestamped Speaking' },
    { value: 'shadowing', label: 'Arguelles Shadowing' },
    { value: 'dictogloss', label: 'Dictogloss Reconstruction' },
    { value: 'mock-test', label: 'Mock Test' },
    { value: 'custom', label: 'Custom' },
  ];

  const handleNew = () => {
    setEditing({
      id: generateId(),
      name: 'New Eval Prompt',
      appliesToType: 'vocab-writing',
      promptText: '',
      scoreScale: 'det-0-160',
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    await saveEvalPrompt(editing);
    setEditing(null);
  };

  const templateVars = [
    '{{prompt}}',
    '{{response}}',
    '{{transcript}}',
    '{{durationSec}}',
    '{{fillerCount}}',
    '{{wpm}}',
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Evaluation Prompts</h2>
          <p className="text-sm text-slate-500 mt-1">
            Customize the AI rubrics used to score your responses
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700"
        >
          + New Prompt
        </button>
      </div>

      {!editing && (
        <div className="space-y-3">
          {evalPrompts.map((ep) => (
            <div key={ep.id} className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">{ep.name}</h3>
                  <span className="text-xs bg-accent-100 text-accent-700 px-2 py-0.5 rounded">
                    {ep.appliesToType}
                  </span>
                  <p className="text-xs text-slate-500 mt-2 line-clamp-2 font-mono">
                    {ep.promptText.slice(0, 150)}...
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing({ ...ep })}
                    className="px-2 py-1 text-xs text-primary-600 hover:bg-primary-50 rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteEvalPrompt(ep.id)}
                    className="px-2 py-1 text-xs text-danger-500 hover:bg-red-50 rounded"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Applies To</label>
              <select
                value={editing.appliesToType}
                onChange={(e) =>
                  setEditing({ ...editing, appliesToType: e.target.value as BlockType })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                {blockTypes.map((bt) => (
                  <option key={bt.value} value={bt.value}>
                    {bt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Score Scale</label>
              <select
                value={editing.scoreScale}
                onChange={(e) =>
                  setEditing({ ...editing, scoreScale: e.target.value as ScoreScale })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                <option value="det-0-160">DET (0–160)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Available variables:</span>
            {templateVars.map((v) => (
              <code key={v} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                {v}
              </code>
            ))}
          </div>

          <textarea
            value={editing.promptText}
            onChange={(e) => setEditing({ ...editing, promptText: e.target.value })}
            rows={14}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono mb-4"
          />

          <div className="flex justify-end gap-3">
            <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-slate-600">
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg"
            >
              Save Prompt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
