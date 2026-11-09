/**
 * App Store — Top-level navigation state.
 *
 * Manages which view the user is looking at (config vs. exam) and
 * which section within the config view is active. This replaces
 * React Router with a simple zustand-driven view switch.
 */

import { create } from 'zustand';

import type { AppView, ConfigSection } from '../types';

// ─── State Shape ─────────────────────────────────────────────────────────────

interface AppState {
  /** Top-level view: 'config' for setup/management, 'exam' for running a session */
  currentView: AppView;

  /** Which section is active within the config view */
  configSection: ConfigSection;
}

interface AppActions {
  /** Switch between config and exam views */
  setView: (view: AppView) => void;

  /** Switch config sub-section (templates, questions, eval-prompts, settings) */
  setConfigSection: (section: ConfigSection) => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState & AppActions>()((set) => ({
  // --- Initial state ---
  currentView: 'config',
  configSection: 'templates',

  // --- Actions ---

  setView: (view) => set({ currentView: view }),

  setConfigSection: (section) => set({ configSection: section }),
}));
