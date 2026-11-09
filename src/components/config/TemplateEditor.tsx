import { useState } from 'react'
import { useConfigStore } from '../../stores/configStore'
import type { SessionTemplate, Block, BlockType } from '../../types'
import { generateId } from '../../utils/helpers'

/**
 * TemplateEditor — CRUD interface for session templates.
 * Supports creating, editing, deleting, reordering blocks within templates.
 */
export function TemplateEditor() {
  const templates = useConfigStore((s) => s.templates)
  const saveTemplate = useConfigStore((s) => s.saveTemplate)
  const deleteTemplate = useConfigStore((s) => s.deleteTemplate)
  const [editingTemplate, setEditingTemplate] = useState<SessionTemplate | null>(null)

  const blockTypes: { value: BlockType; label: string }[] = [
    { value: 'brain-dump', label: '🧠 Brain Dump' },
    { value: 'vocab-writing', label: '✍️ Vocab & Writing' },
    { value: 'speaking', label: '🎤 Speaking' },
    { value: 'mock-test', label: '📝 Mock Test' },
    { value: 'custom', label: '🔧 Custom' },
  ]

  const handleNew = () => {
    const newTemplate: SessionTemplate = {
      id: generateId(),
      name: 'New Session',
      blocks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setEditingTemplate(newTemplate)
  }

  const handleEdit = (template: SessionTemplate) => {
    setEditingTemplate({ ...template, blocks: [...template.blocks] })
  }

  const handleSave = async () => {
    if (!editingTemplate) return
    await saveTemplate({
      ...editingTemplate,
      updatedAt: new Date().toISOString(),
    })
    setEditingTemplate(null)
  }

  const handleCancel = () => {
    setEditingTemplate(null)
  }

  const addBlock = () => {
    if (!editingTemplate) return
    const newBlock: Block = {
      id: generateId(),
      name: 'New Block',
      type: 'brain-dump',
      durationSec: 300,
      instructions: '',
      autoAdvance: true,
      evalPromptId: '',
    }
    setEditingTemplate({
      ...editingTemplate,
      blocks: [...editingTemplate.blocks, newBlock],
    })
  }

  const updateBlock = (index: number, updates: Partial<Block>) => {
    if (!editingTemplate) return
    const blocks = [...editingTemplate.blocks]
    blocks[index] = { ...blocks[index], ...updates }
    setEditingTemplate({ ...editingTemplate, blocks })
  }

  const removeBlock = (index: number) => {
    if (!editingTemplate) return
    const blocks = editingTemplate.blocks.filter((_, i) => i !== index)
    setEditingTemplate({ ...editingTemplate, blocks })
  }

  const moveBlock = (index: number, direction: 'up' | 'down') => {
    if (!editingTemplate) return
    const blocks = [...editingTemplate.blocks]
    const swapIdx = direction === 'up' ? index - 1 : index + 1
    if (swapIdx < 0 || swapIdx >= blocks.length) return
    ;[blocks[index], blocks[swapIdx]] = [blocks[swapIdx], blocks[index]]
    setEditingTemplate({ ...editingTemplate, blocks })
  }

  const totalDuration = editingTemplate?.blocks.reduce((sum, b) => sum + b.durationSec, 0) ?? 0

  // Active (non-deleted) templates
  const activeTemplates = templates.filter((t) => !t.deletedAt)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Session Templates</h2>
          <p className="text-sm text-slate-500 mt-1">
            Create and manage your practice session configurations
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
        >
          + New Template
        </button>
      </div>

      {/* Template List */}
      {!editingTemplate && (
        <div className="space-y-3">
          {activeTemplates.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <p className="text-lg">No templates yet</p>
              <p className="text-sm mt-1">Create your first session template to get started</p>
            </div>
          )}
          {activeTemplates.map((template) => (
            <div
              key={template.id}
              className="bg-white rounded-lg border border-slate-200 p-4 hover:border-primary-300 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">{template.name}</h3>
                  <p className="text-sm text-slate-500 mt-0.5">
                    {template.blocks.length} blocks •{' '}
                    {Math.ceil(template.blocks.reduce((s, b) => s + b.durationSec, 0) / 60)} min total
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleEdit(template)}
                    className="px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteTemplate(template.id)}
                    className="px-3 py-1.5 text-sm text-danger-500 hover:bg-red-50 rounded-md transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {/* Block preview */}
              <div className="flex gap-1.5 mt-3">
                {template.blocks.map((block) => (
                  <div
                    key={block.id}
                    className="flex-1 bg-slate-100 rounded px-2 py-1 text-xs text-slate-600 text-center truncate"
                    title={`${block.name} (${Math.ceil(block.durationSec / 60)}m)`}
                  >
                    {block.name}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Template Editor */}
      {editingTemplate && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-5 pb-3 border-b border-slate-100">
            <button
              type="button"
              onClick={handleCancel}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
            >
              ← Back to Templates List
            </button>
            <span className="text-xs text-slate-400">Editing Template Configuration</span>
          </div>

          {/* Template name */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-1">Template Name</label>
            <input
              type="text"
              value={editingTemplate.name}
              onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              placeholder="e.g., Full Mock Session"
            />
          </div>

          {/* Blocks */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-900">
                Blocks ({editingTemplate.blocks.length})
              </h3>
              <span className="text-sm text-slate-500">
                Total: {Math.floor(totalDuration / 60)}:{String(totalDuration % 60).padStart(2, '0')}
              </span>
            </div>

            <div className="space-y-3">
              {editingTemplate.blocks.map((block, index) => (
                <div
                  key={block.id}
                  className="border border-slate-200 rounded-lg p-4 bg-slate-50"
                >
                  <div className="flex items-start gap-3">
                    {/* Reorder buttons */}
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        onClick={() => moveBlock(index, 'up')}
                        disabled={index === 0}
                        className="text-slate-400 hover:text-slate-600 disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => moveBlock(index, 'down')}
                        disabled={index === editingTemplate.blocks.length - 1}
                        className="text-slate-400 hover:text-slate-600 disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </div>

                    {/* Block fields */}
                    <div className="flex-1 grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
                        <input
                          type="text"
                          value={block.name}
                          onChange={(e) => updateBlock(index, { name: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
                        <select
                          value={block.type}
                          onChange={(e) => updateBlock(index, { type: e.target.value as BlockType })}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        >
                          {blockTypes.map((bt) => (
                            <option key={bt.value} value={bt.value}>
                              {bt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">
                          Duration (min)
                        </label>
                        <input
                          type="number"
                          min={1}
                          value={Math.ceil(block.durationSec / 60)}
                          onChange={(e) =>
                            updateBlock(index, { durationSec: Number(e.target.value) * 60 })
                          }
                          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-slate-500 mb-1">
                          Instructions
                        </label>
                        <textarea
                          value={block.instructions}
                          onChange={(e) => updateBlock(index, { instructions: e.target.value })}
                          rows={2}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                          placeholder="Instructions shown to the student..."
                        />
                      </div>
                      <div className="flex items-end">
                        <label className="flex items-center gap-2 text-sm text-slate-600">
                          <input
                            type="checkbox"
                            checked={block.autoAdvance}
                            onChange={(e) => updateBlock(index, { autoAdvance: e.target.checked })}
                            className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                          />
                          Auto-advance
                        </label>
                      </div>
                    </div>

                    {/* Remove button */}
                    <button
                      onClick={() => removeBlock(index)}
                      className="text-slate-400 hover:text-danger-500 transition-colors mt-1"
                      title="Remove block"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={addBlock}
              className="mt-3 w-full py-2.5 border-2 border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-primary-400 hover:text-primary-600 transition-colors"
            >
              + Add Block
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
            >
              Save Template
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

