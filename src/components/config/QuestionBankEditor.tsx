import { useState } from 'react'
import { useConfigStore } from '../../stores/configStore'
import type { QuestionBankItem, DETSkill, DETQuestionType } from '../../types'
import { generateId } from '../../utils/helpers'

/**
 * QuestionBankEditor — CRUD for DET practice questions.
 * Filtered by skill, supports tags and difficulty levels.
 */
export function QuestionBankEditor() {
  const questions = useConfigStore((s) => s.questions)
  const saveQuestion = useConfigStore((s) => s.saveQuestion)
  const deleteQuestion = useConfigStore((s) => s.deleteQuestion)
  const [filterSkill, setFilterSkill] = useState<DETSkill | 'all'>('all')
  const [editingQuestion, setEditingQuestion] = useState<QuestionBankItem | null>(null)

  const skills: { value: DETSkill; label: string }[] = [
    { value: 'reading', label: '📖 Reading' },
    { value: 'writing', label: '✍️ Writing' },
    { value: 'speaking', label: '🎤 Speaking' },
    { value: 'listening', label: '👂 Listening' },
  ]

  const questionTypes: { value: DETQuestionType; label: string; skill: DETSkill }[] = [
    { value: 'read-aloud', label: 'Read Aloud', skill: 'reading' },
    { value: 'write-about-photo', label: 'Write About Photo', skill: 'writing' },
    { value: 'listen-and-type', label: 'Listen & Type', skill: 'listening' },
    { value: 'interactive-writing', label: 'Interactive Writing', skill: 'writing' },
    { value: 'interactive-speaking', label: 'Interactive Speaking', skill: 'speaking' },
    { value: 'speaking-sample', label: 'Speaking Sample', skill: 'speaking' },
  ]

  const filtered = filterSkill === 'all'
    ? questions
    : questions.filter((q) => q.skill === filterSkill)

  const handleNew = () => {
    setEditingQuestion({
      id: generateId(),
      skill: 'writing',
      type: 'interactive-writing',
      prompt: '',
      difficulty: 'mid',
      tags: [],
    })
  }

  const handleSave = async () => {
    if (!editingQuestion) return
    await saveQuestion(editingQuestion)
    setEditingQuestion(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Question Bank</h2>
          <p className="text-sm text-slate-500 mt-1">
            {questions.length} questions across all skills
          </p>
        </div>
        <button
          onClick={handleNew}
          className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
        >
          + New Question
        </button>
      </div>

      {/* Skill filter tabs */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFilterSkill('all')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            filterSkill === 'all'
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          All ({questions.length})
        </button>
        {skills.map((s) => {
          const count = questions.filter((q) => q.skill === s.value).length
          return (
            <button
              key={s.value}
              onClick={() => setFilterSkill(s.value)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                filterSkill === s.value
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {s.label} ({count})
            </button>
          )
        })}
      </div>

      {/* Question list */}
      {!editingQuestion && (
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="text-center py-8 text-slate-400">
              <p>No questions in this category</p>
            </div>
          )}
          {filtered.map((q) => (
            <div
              key={q.id}
              className="bg-white rounded-lg border border-slate-200 p-4 hover:border-primary-300 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-accent-100 text-accent-700">
                      {q.skill}
                    </span>
                    <span className="text-xs text-slate-400">{q.type}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      q.difficulty === 'hard' ? 'bg-red-100 text-red-700' :
                      q.difficulty === 'easy' ? 'bg-green-100 text-green-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {q.difficulty}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 line-clamp-2">{q.prompt}</p>
                  {q.tags.length > 0 && (
                    <div className="flex gap-1 mt-2">
                      {q.tags.map((tag) => (
                        <span key={tag} className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditingQuestion({ ...q })}
                    className="px-2 py-1 text-xs text-primary-600 hover:bg-primary-50 rounded transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteQuestion(q.id)}
                    className="px-2 py-1 text-xs text-danger-500 hover:bg-red-50 rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Question Editor */}
      {editingQuestion && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
            <button
              type="button"
              onClick={() => setEditingQuestion(null)}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
            >
              ← Back to Questions List
            </button>
            <span className="text-xs text-slate-400">Question Item Setup</span>
          </div>

          <h3 className="font-semibold text-slate-900 mb-4">
            {questions.find((q) => q.id === editingQuestion.id) ? 'Edit' : 'New'} Question
          </h3>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Skill</label>
              <select
                value={editingQuestion.skill}
                onChange={(e) =>
                  setEditingQuestion({ ...editingQuestion, skill: e.target.value as DETSkill })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {skills.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Question Type</label>
              <select
                value={editingQuestion.type}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    type: e.target.value as DETQuestionType,
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {questionTypes
                  .filter((qt) => qt.skill === editingQuestion.skill)
                  .map((qt) => (
                    <option key={qt.value} value={qt.value}>
                      {qt.label}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Difficulty</label>
              <select
                value={editingQuestion.difficulty}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    difficulty: e.target.value as 'easy' | 'mid' | 'hard',
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="easy">Easy</option>
                <option value="mid">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={editingQuestion.tags.join(', ')}
                onChange={(e) =>
                  setEditingQuestion({
                    ...editingQuestion,
                    tags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="e.g., academic, daily-life"
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1">Prompt</label>
            <textarea
              value={editingQuestion.prompt}
              onChange={(e) =>
                setEditingQuestion({ ...editingQuestion, prompt: e.target.value })
              }
              rows={4}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              placeholder="The question or prompt text..."
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Sample Answer (optional)
            </label>
            <textarea
              value={editingQuestion.sampleAnswer ?? ''}
              onChange={(e) =>
                setEditingQuestion({
                  ...editingQuestion,
                  sampleAnswer: e.target.value || undefined,
                })
              }
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              placeholder="Optional reference answer..."
            />
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={() => setEditingQuestion(null)}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
            >
              Save Question
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

