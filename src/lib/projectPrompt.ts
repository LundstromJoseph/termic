// The project's default initial prompt (Settings > Repository > More).
// Resolved only here, in the frontend: Rust never types it, so CLI/MCP,
// races, PR reviews and schedules never send it.

import type { Project } from "@/lib/types";

/** Settings cap on the default. Well under MAX_PROMPT_CHARS so an issue
 *  prompt's instruction tail still fits after it. */
export const MAX_DEFAULT_PROMPT_CHARS = 2000;

export function projectDefaultPrompt(p: Pick<Project, "default_initial_prompt"> | null | undefined): string {
  return (p?.default_initial_prompt ?? "").trim();
}

/** Room left for the text that follows `def` (plus its blank-line join). */
export function promptRoom(def: string, max: number): number {
  return def ? Math.max(0, max - def.length - 2) : max;
}

/** `<def>\n\n<text>`, capped at `max`. The text is cut, never the default:
 *  the default is the user's standing instruction, a link or issue body is
 *  context the agent can re-read. */
export function withProjectPrompt(def: string, text: string, max: number): string {
  if (!def) return text.slice(0, max);
  if (!text.trim()) return def.slice(0, max);
  const room = promptRoom(def, max);
  if (room === 0) return def.slice(0, max);
  return `${def}\n\n${text.slice(0, room)}`;
}
