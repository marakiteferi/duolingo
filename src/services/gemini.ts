import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIFeedback } from '../types';

export type EvaluationResult = AIFeedback;

export interface EvaluateParams {
  apiKey: string;
  evalPromptTemplate: string;
  variables: Record<string, string>;
}

const GEMINI_MODEL = 'gemini-2.0-flash';
const REQUEST_TIMEOUT_MS = 18_000;

/**
 * Detects if the student input is keyboard-smash gibberish (e.g., "aksdj ajsd kajd...")
 * or way too short so we can return an immediate, accurate DET score without hanging.
 */
function detectGibberishOrEmpty(text: string): { isGibberish: boolean; reason?: string } {
  const clean = text.trim();
  if (!clean || clean === '[No speech detected in recording]' || clean === '[No speech detected]') {
    return { isGibberish: true, reason: 'No meaningful response or speech was detected.' };
  }

  const words = clean
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 3) {
    return {
      isGibberish: true,
      reason: 'Response is too brief (fewer than 3 words) to demonstrate proficiency.',
    };
  }

  // Check how many words contain a basic English vowel or common structure,
  // or repeated keyboard smash patterns like "aksdj", "kdd", "djdak"
  const commonShortWords = new Set([
    'a', 'i', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'be', 'as', 'by', 'or', 'we', 'an', 'so', 'no', 'up', 'if', 'my', 'do', 'go'
  ]);
  let suspiciousCount = 0;

  for (const w of words) {
    const hasVowel = /[aeiouy]/.test(w);
    const hasSmashCluster = /[bcdfghjklmnpqrstvwxz]{4,}|(aj|jd|kd|dk|sj|ak){2,}/i.test(w);
    if (!hasVowel || hasSmashCluster || (w.length <= 2 && !commonShortWords.has(w))) {
      suspiciousCount += 1;
    }
  }

  if (suspiciousCount / words.length >= 0.45) {
    return {
      isGibberish: true,
      reason:
        'Response consists largely of non-word character sequences or keyboard gibberish rather than coherent English clauses.',
    };
  }

  return { isGibberish: false };
}

/**
 * Builds an instant heuristic evaluation when input is gibberish or when offline/timed out.
 */
export function buildLocalFallbackEvaluation(
  studentText: string,
  promptText: string,
  noteReason?: string
): AIFeedback {
  const check = detectGibberishOrEmpty(studentText);
  if (check.isGibberish) {
    return {
      overallScore: 25,
      subscores: {
        literacy: 25,
        comprehension: 25,
        conversation: 25,
        production: 20,
      },
      criteria: {
        grammar: check.reason || 'Unintelligible or incomplete syntax.',
        vocabulary: 'No valid academic collocations or recognizable lexical items detected.',
        coherence: 'Lacks meaningful propositional content addressing the prompt.',
      },
      strengths: ['Submitted block attempt'],
      weaknesses: [
        check.reason || 'Input did not contain coherent English sentences.',
        'Did not address the task prompt or incorporate target collocations.',
      ],
      suggestions: [
        'Write complete, meaningful sentences that directly address the prompt topic.',
        'Click "Apply Fixes & Rewrite" below to replace the placeholder text with a real paragraph.',
      ],
      suggestedFix: ` Write 3–4 structured sentences addressing: "${promptText.slice(0, 120)}..."`,
      note: noteReason,
    };
  }

  const words = studentText.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const uniqueRatio = new Set(words.map((w) => w.toLowerCase())).size / Math.max(1, wordCount);
  const hasComplexMarkers =
    /\b(although|whereas|consequently|furthermore|nevertheless|while|despite|therefore|moreover)\b/i.test(
      studentText
    );

  const baseScore = Math.min(
    145,
    Math.max(
      65,
      Math.round(75 + Math.min(45, wordCount * 0.45) + (hasComplexMarkers ? 15 : 0) + uniqueRatio * 15)
    )
  );

  return {
    overallScore: baseScore,
    subscores: {
      literacy: baseScore,
      comprehension: baseScore,
      conversation: Math.max(60, baseScore - 5),
      production: baseScore,
    },
    criteria: {
      grammar: hasComplexMarkers
        ? 'Includes subordinate or discourse transitions.'
        : 'Add more complex subordination (whereas, although, consequently).',
      vocabulary: `${wordCount} words (${Math.round(uniqueRatio * 100)}% lexical variety).`,
      coherence: 'Evaluated via instant local rubric fallback.',
    },
    strengths: [
      `Produced ${wordCount} words on topic`,
      hasComplexMarkers
        ? 'Used academic discourse markers'
        : 'Clear baseline sentence structure',
    ],
    weaknesses: hasComplexMarkers
      ? ['Could further tighten C1/C2 collocation precision']
      : ['Limited use of subordinate clauses and high-level academic transitions'],
    suggestions: [
      'Embed relative clauses and contrastive transitions (whereas, meskipun/although).',
    ],
    note: noteReason || 'Evaluated via local offline fallback rubric.',
  };
}

function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });

  const studentText = vars.response || vars.transcript || '';
  if (studentText && !template.includes('{{response}}') && !template.includes('{{transcript}}')) {
    output += `\n\n---\nTask Prompt: ${vars.prompt ?? ''}\nDuration: ${vars.durationSec ?? 0}s\nStudent Response:\n${studentText}`;
  }
  return output;
}

function validateEvaluationResult(data: unknown): AIFeedback {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Gemini returned a non-object response.');
  }
  const obj = data as Record<string, unknown>;

  const toNumericRecord = (val: unknown): Record<string, number> => {
    if (typeof val !== 'object' || val === null) return {};
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, Math.round(v as number)])
    );
  };

  const subscores = toNumericRecord(obj.subscores ?? obj.subscore_breakdown);

  const criteria: Record<string, string> = {};
  if (typeof obj.criteria === 'object' && obj.criteria !== null) {
    for (const [k, v] of Object.entries(obj.criteria as Record<string, unknown>)) {
      if (typeof v === 'string') criteria[k] = v;
      else if (typeof v === 'number' && !(k in subscores)) subscores[k] = Math.round(v);
    }
  }

  const toStringArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.filter((item): item is string => typeof item === 'string');
  };

  const subValues = Object.values(subscores);
  const computedAvg =
    subValues.length > 0
      ? Math.round(subValues.reduce((a, b) => a + b, 0) / subValues.length)
      : undefined;

  const overallScore =
    typeof obj.overallScore === 'number'
      ? Math.round(obj.overallScore)
      : computedAvg;

  const suggestions = toStringArray(obj.suggestions);
  const suggestedFix = typeof obj.suggestedFix === 'string' ? obj.suggestedFix : undefined;
  if (suggestedFix && !suggestions.includes(suggestedFix)) {
    suggestions.unshift(`150-Band Rewrite: ${suggestedFix}`);
  }

  return {
    overallScore,
    subscores,
    criteria,
    strengths: toStringArray(obj.strengths),
    weaknesses: toStringArray(obj.weaknesses),
    suggestions,
    suggestedFix,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}

export async function evaluateResponse(params: EvaluateParams): Promise<AIFeedback> {
  const { apiKey, evalPromptTemplate, variables } = params;
  const studentText = (variables.response || variables.transcript || '').trim();
  const promptText = variables.prompt || '';

  // 1. Instant Gibberish / Empty Check (prevents hanging on "aksdj ajsd...")
  const gibberishCheck = detectGibberishOrEmpty(studentText);
  if (gibberishCheck.isGibberish) {
    return buildLocalFallbackEvaluation(studentText, promptText);
  }

  // 2. If no API key configured, use local rubric immediately instead of failing
  if (!apiKey || !apiKey.trim()) {
    return buildLocalFallbackEvaluation(
      studentText,
      promptText,
      'Gemini API key not set — graded using built-in local heuristic rubric.'
    );
  }

  const prompt = interpolateTemplate(evalPromptTemplate, variables);

  try {
    return await callGeminiWithTimeout(apiKey.trim(), prompt);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return buildLocalFallbackEvaluation(
      studentText,
      promptText,
      `Gemini API timed out or was unreachable (${errMsg.slice(0, 80)}) — graded via local fallback rubric.`
    );
  }
}

async function callGeminiWithTimeout(apiKey: string, prompt: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('Gemini evaluation timed out after 18 seconds')),
      REQUEST_TIMEOUT_MS
    );
  });

  const requestPromise = (async () => {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const text = result.response.text();
    if (!text) throw new Error('Gemini returned an empty response.');
    const parsed = JSON.parse(text) as unknown;
    return validateEvaluationResult(parsed);
  })();

  return Promise.race([requestPromise, timeoutPromise]);
}
