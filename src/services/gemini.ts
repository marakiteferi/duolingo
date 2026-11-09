/**
 * Gemini AI evaluation service.
 *
 * Uses Google's Generative AI SDK to send student responses to Gemini
 * for structured evaluation. The service:
 *   - Interpolates {{variable}} placeholders in prompt templates
 *   - Requests JSON output via `responseMimeType`
 *   - Parses and validates the structured evaluation result
 *   - Retries once on transient failures with a 2-second delay
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIFeedback } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parameters for `evaluateResponse` */
export interface EvaluateParams {
  /** Gemini API key */
  apiKey: string;
  /** The prompt template with {{variable}} placeholders */
  evalPromptTemplate: string;
  /** Values to substitute for each {{variable}} in the template */
  variables: Record<string, string>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Gemini model — Flash variant for fast, cost-effective evaluation */
const GEMINI_MODEL = 'gemini-2.0-flash';

/** Delay (ms) before retrying after a transient failure */
const RETRY_DELAY_MS = 2_000;

/** Request timeout — abort if Gemini takes too long */
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replace all `{{key}}` placeholders in `template` with values from `vars`.
 * Unknown placeholders are left as-is so prompts can reference optional fields.
 */
function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key] : match;
  });
}

/**
 * Type-guard: validate that a parsed JSON value matches the EvaluationResult shape.
 * We're lenient — missing optional fields are filled with defaults.
 */
function validateEvaluationResult(data: unknown): AIFeedback {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Gemini returned a non-object response.');
  }

  const obj = data as Record<string, unknown>;

  // ── subscores / criteria (Gemini might return either key name) ──
  const toNumericRecord = (val: unknown): Record<string, number> => {
    if (typeof val !== 'object' || val === null) return {};
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, v as number]),
    );
  };

  const subscores = toNumericRecord(obj.subscores ?? obj.subscore_breakdown);
  const criteria = typeof obj.criteria === 'object'
    ? (obj.criteria as Record<string, string>)
    : {};

  // ── string arrays ──
  const toStringArray = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.filter((item): item is string => typeof item === 'string');
  };

  return {
    subscores,
    criteria,
    strengths: toStringArray(obj.strengths),
    weaknesses: toStringArray(obj.weaknesses),
    suggestions: toStringArray(obj.suggestions),
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}

/** Simple async delay */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main Service ────────────────────────────────────────────────────────────

/**
 * Evaluate a student's response using Gemini.
 *
 * Sends the interpolated prompt to Gemini, requesting structured JSON output,
 * then validates and returns the result.
 *
 * @throws On persistent failures (network down, invalid key, malformed response).
 */
export async function evaluateResponse(params: EvaluateParams): Promise<AIFeedback> {
  const { apiKey, evalPromptTemplate, variables } = params;

  if (!apiKey) {
    throw new Error('Gemini API key is required for evaluation.');
  }

  // Build the final prompt from the template + variables
  const prompt = interpolateTemplate(evalPromptTemplate, variables);

  // Attempt with one retry on transient failures
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await callGemini(apiKey, prompt);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-transient errors
      if (isNonRetryableError(lastError)) {
        throw lastError;
      }

      // Wait before retrying (only on first attempt)
      if (attempt === 0) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  // Both attempts failed
  throw new Error(
    `Gemini evaluation failed after retry: ${lastError?.message ?? 'Unknown error'}`
  );
}

/**
 * Determine whether an error is permanent and should not be retried.
 */
function isNonRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('api key') ||
    msg.includes('invalid') ||
    msg.includes('permission') ||
    msg.includes('forbidden') ||
    msg.includes('not found')
  );
}

/**
 * Make the actual Gemini API call and parse the result.
 */
async function callGemini(apiKey: string, prompt: string): Promise<AIFeedback> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  // ── Timeout wrapper ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    clearTimeout(timeoutId);

    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }

    // ── Parse JSON ──
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Failed to parse Gemini response as JSON. Raw text: ${text.slice(0, 200)}`
      );
    }

    // ── Validate shape ──
    return validateEvaluationResult(parsed);
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error) {
      // Enrich timeout errors
      if (error.name === 'AbortError') {
        throw new Error(
          `Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
        );
      }

      // Surface rate limit errors clearly
      if (error.message.includes('429') || error.message.toLowerCase().includes('rate')) {
        throw new Error('Gemini API rate limit exceeded. Please wait and try again.');
      }

      throw error;
    }

    throw new Error(`Gemini call failed: ${String(error)}`);
  }
}
