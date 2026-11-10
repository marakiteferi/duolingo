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
  paragraph1WithBlanks: string;
  paragraph1Sentences: string[];
  blanks: ClozeBlankItem[];
  passageGapOptions: string[];
  correctPassageGap: string;
  paragraph2Sentences: string[];
  highlightQuestion1: string;
  correctHighlight1: string;
  highlightQuestion2: string;
  correctHighlight2: string;
  mainIdeaOptions: string[];
  correctMainIdea: string;
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
  passageWithBlanks: string;
  blanks: ReadAndCompleteBlank[];
}

export interface YoutubeAudioSource {
  clipKey: string;
  url: string;
  startTime: string;
  endTime: string;
  speaker: string;
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
  youtubeSource?: YoutubeAudioSource;
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
  blindShadowing?: boolean;
  speechSpeed?: number;
  communicativePressure?: boolean;
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
