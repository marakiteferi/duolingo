export type DETSkill = 'reading' | 'writing' | 'speaking' | 'listening';

export type DETQuestionType =
  | 'interactive-reading'
  | 'read-and-complete'
  | 'read-aloud'
  | 'write-about-photo'
  | 'listen-and-type'
  | 'interactive-writing'
  | 'interactive-speaking'
  | 'speaking-sample';

export type BlockType =
  | 'interactive-reading'
  | 'brain-dump'
  | 'vocab-writing'
  | 'speaking'
  | 'shadowing'
  | 'dictogloss'
  | 'mock-test'
  | 'custom';

export type STTProvider = 'local-whisper' | 'whisper' | 'web-speech-api';
export type ViewMode = 'config' | 'exam';
export type AppView = ViewMode;
export type SessionStatus = 'in-progress' | 'completed' | 'abandoned';
export type ScoreScale = 'det-0-160' | 'custom';
export type ConfigSection = 'templates' | 'questions' | 'eval-prompts' | 'history' | 'settings';

export interface SRSData {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewDate: string;
}

export interface SRSDefaults {
  startEase: number;
  startIntervalDays: number;
}

export interface Settings {
  id: 'app-settings';
  geminiApiKey: string;
  sttProvider: STTProvider;
  localWhisperUrl?: string;
  localSttEndpoint?: string;
  sttApiKey?: string;
  autoAdvanceDefault: boolean;
  instantFeedbackDefault?: boolean;
  srsDefaults: SRSDefaults;
}

export interface ClozeBlankItem {
  id: string;
  options: string[];
  correctAnswer: string;
}

export interface InteractiveReadingData {
  sourceName: string;
  /** Paragraph 1 containing {{1}}, {{2}}, etc. for "Complete the Sentences" */
  paragraph1WithBlanks: string;
  /** Clean Paragraph 1 split into individual sentences for "Highlight the Answer" */
  paragraph1Sentences: string[];
  blanks: ClozeBlankItem[];
  /** Step 2: Complete the Passage (bridge sentence between P1 and P2) */
  passageGapOptions: string[];
  correctPassageGap: string;
  /** Clean Paragraph 2 split into individual sentences for "Highlight the Answer" */
  paragraph2Sentences: string[];
  /** Step 3: Highlight the Answer #1 */
  highlightQuestion1: string;
  correctHighlight1: string;
  /** Step 4: Highlight the Answer #2 */
  highlightQuestion2: string;
  correctHighlight2: string;
  /** Step 5: Identify the Idea */
  mainIdeaOptions: string[];
  correctMainIdea: string;
  /** Step 6: Title the Passage */
  titleOptions: string[];
  correctTitle: string;
}

export interface ReadAndCompleteBlank {
  id: string;
  prefix: string;
  missingSuffix: string;
  fullWord: string;
}

export interface ReadAndCompleteData {
  sourceName: string;
  title: string;
  /** Passage containing {{1}}, {{2}}, etc. for prefix completion */
  passageWithBlanks: string;
  blanks: ReadAndCompleteBlank[];
}

export interface QuestionBankItem {
  id: string;
  skill: DETSkill;
  type: DETQuestionType;
  prompt: string;
  sampleAnswer?: string;
  sourceAttribution?: string;
  targetChunks?: string[];
  sourceAudioText?: string;
  audioUrl?: string;
  interactiveReading?: InteractiveReadingData;
  readAndComplete?: ReadAndCompleteData;
  difficulty: number | 'easy' | 'mid' | 'hard';
  tags: string[];
  srs?: SRSData;
}

export interface EvalPrompt {
  id: string;
  name: string;
  appliesToType: BlockType;
  promptText: string;
  scoreScale: ScoreScale;
}

export interface Block {
  id: string;
  name: string;
  type: BlockType;
  durationSec: number;
  instructions: string;
  questionSetId?: string;
  preferredQuestionType?: DETQuestionType | 'adaptive';
  autoAdvance: boolean;
  evalPromptId: string;
}

export type BlockConfig = Block;

export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  blocks: Block[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface AIFeedback {
  overallScore?: number;
  subscores: Record<string, number>;
  criteria: Record<string, string>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  suggestedFix?: string;
  note?: string;
}

export interface BlockResponse {
  blockId: string;
  type?: BlockType;
  questionType?: string;
  questionId?: string;
  promptSnapshot?: string;
  textOrTranscript?: string;
  timestampedTranscript?: string;
  audioDurationSec?: number;
  fragmentNotes?: string;
  attemptCount?: number;
  previousDraft?: string;
  audioBlobRef?: string;
  isComplete: boolean;
  timeSpentSec: number;
  fillerCount?: number;
  wpm?: number;
  aiSubscores?: Record<string, number>;
  aiOverallScore?: number;
  aiFeedback?: AIFeedback;
  evalPendingOffline?: boolean;
}

export interface SessionSummary {
  overallScore?: number;
  perSkillScores?: Partial<Record<DETSkill, number>>;
  durationSec: number;
}

export interface SessionRun {
  id: string;
  templateId: string | null;
  templateName: string;
  blockConfigs: BlockConfig[];
  status: SessionStatus;
  currentBlockIndex: number;
  overallElapsedSec: number;
  instantFeedback?: boolean;
  communicativePressure?: boolean;
  preferredQuestionType?: DETQuestionType | 'all' | 'adaptive';
  startedAt: string;
  endedAt: string | null;
  responses: Record<string, BlockResponse>;
  summary?: SessionSummary;
}
