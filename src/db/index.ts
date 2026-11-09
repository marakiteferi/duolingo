/**
 * db/index.ts — Barrel re-export for the database layer.
 *
 * Import from '@/db' (or '../db') to get both the singleton instance
 * and the class (useful for type annotations or testing).
 */

export { db, DETDatabase } from './database';
