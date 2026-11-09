/**
 * General-purpose utility functions used across the DET Prep App.
 *
 * All functions are pure (no side-effects except `generateId` which uses
 * the crypto API) and fully typed.
 */

// ─── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Format a duration in seconds into "MM:SS" display format.
 *
 * Handles edge cases:
 *   - Negative values are clamped to 0
 *   - Values >= 3600 still display correctly (e.g., 3661 → "61:01")
 *
 * @param seconds — Duration in whole seconds.
 * @returns Formatted string like "05:30" or "00:00".
 */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ─── ID Generation ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random UUID (v4).
 *
 * Uses `crypto.randomUUID()` which is available in all modern browsers
 * and Node.js 19+. Falls back to `crypto.getRandomValues()` if the
 * native method is unavailable.
 *
 * @returns A UUID string like "a1b2c3d4-e5f6-7890-abcd-ef1234567890".
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback: manually construct a v4 UUID
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version (4) and variant (10xx) bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

/**
 * Format an ISO date string into a human-readable display format.
 *
 * Examples:
 *   "2025-03-15T10:30:00Z" → "Mar 15, 2025, 10:30 AM"
 *
 * Falls back to the raw ISO string if parsing fails.
 *
 * @param isoString — An ISO 8601 date/time string.
 * @returns A locale-formatted date string.
 */
export function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    // Guard against invalid dates
    if (isNaN(date.getTime())) {
      return isoString;
    }
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

// ─── Math ────────────────────────────────────────────────────────────────────

/**
 * Clamp a numeric value to the range [min, max].
 *
 * @param value — The value to clamp.
 * @param min   — Lower bound (inclusive).
 * @param max   — Upper bound (inclusive).
 * @returns The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ─── Function Utilities ──────────────────────────────────────────────────────

/**
 * Create a debounced version of `fn` that delays invocation until `ms`
 * milliseconds have elapsed since the last call.
 *
 * If called again within the window, the previous pending invocation is
 * cancelled and the timer restarts. Useful for search inputs, window
 * resize handlers, etc.
 *
 * @param fn — The function to debounce.
 * @param ms — Debounce window in milliseconds.
 * @returns A debounced wrapper with the same signature as `fn`.
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  ms: number,
): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, ms);
  };

  // Cast is safe — the wrapper preserves the parameter types.
  // Return type changes from T's return to void, which is expected for debounced fns.
  return debounced as unknown as T;
}
