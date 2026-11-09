import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIFeedback } from '../types';

export type EvaluationResult = AIFeedback;

export interface EvaluateParams {
  apiKey: string;
  evalPromptTemplate: string;
  variables: Record<string, string>;
}

const GEMINI_MODEL = 'gemini-2.0-flash';
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 35_000;

function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });

  // Safety guarantee: if the user's template didn't include {{response}} or {{transcript}},
  // append the prompt and student response automatically so Gemini always sees it.
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
    suggestions.unshift(`145+ Rewrite: ${suggestedFix}`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function evaluateResponse(params: EvaluateParams): Promise<AIFeedback> {
  const { apiKey, evalPromptTemplate, variables } = params;

  if (!apiKey) {
    throw new Error('Gemini API key is missing. Add your free Google AI Studio key in Config -> Settings.');
  }

  const prompt = interpolateTemplate(evalPromptTemplate, variables);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callGemini(apiKey, prompt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isNonRetryableError(lastError)) throw lastError;
      if (attempt === 0) await delay(RETRY_DELAY_MS);
    }
  }

  throw new Error(`Gemini evaluation failed: ${lastError?.message ?? 'Unknown error'}`);
}

function isNonRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes('api key') || msg.includes('invalid') || msg.includes('permission') || msg.includes('forbidden');
}

async function callGemini(apiKey: string, prompt: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    clearTimeout(timeoutId);

    const text = result.response.text();
    if (!text) throw new Error('Gemini returned an empty response.');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Failed to parse Gemini JSON: ${text.slice(0, 160)}`);
    }

    return validateEvaluationResult(parsed);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
}
