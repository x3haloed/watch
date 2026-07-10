import type { JsonObject, WatchEvent } from './types.js';

export type ResidentPresenceState = 'offline' | 'ready' | 'queued' | 'thinking' | 'using_tools';

export type ResidentPresence = {
  state: ResidentPresenceState;
  label: 'Offline' | 'Ready' | 'Queued' | 'Thinking' | 'Using tools';
  tone: 'error' | 'ok' | 'pending' | 'thinking' | 'tool';
};

export function deriveResidentPresence(
  runtime: { running: boolean; soundingActive: boolean; soundQueued: boolean },
  toolActivityActive = false,
): ResidentPresence {
  if (!runtime.running) return { state: 'offline', label: 'Offline', tone: 'error' };
  if (runtime.soundingActive && toolActivityActive) return { state: 'using_tools', label: 'Using tools', tone: 'tool' };
  if (runtime.soundingActive) return { state: 'thinking', label: 'Thinking', tone: 'thinking' };
  if (runtime.soundQueued) return { state: 'queued', label: 'Queued', tone: 'pending' };
  return { state: 'ready', label: 'Ready', tone: 'ok' };
}

export function isToolActivityEvent(event: WatchEvent): boolean {
  if (event.type === 'terminal_started' || event.type === 'terminal_input') return true;
  if (event.type !== 'model_step_finished') return false;
  return containsToolActivity(event.step);
}

function containsToolActivity(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsToolActivity);
  if (!value || typeof value !== 'object') return false;
  const object = value as JsonObject;
  if (['tool-call', 'tool_call', 'tool-result', 'tool_result'].includes(String(object.type ?? ''))) return true;
  return Object.values(object).some(containsToolActivity);
}
