import { isHexAccent } from "@/lib/accents";
import type { TaskBadge } from "@/lib/types";

/** Badge tone -> theme token. A hex is the agent's choice and drawn as given. */
export const BADGE_TONES: Record<string, string> = {
  good: "var(--color-ok)",
  warning: "var(--color-warn)",
  error: "var(--color-err)",
  neutral: "var(--color-fg-dim)",
};

export function badgeColor(color: string): string {
  if (Object.hasOwn(BADGE_TONES, color)) return BADGE_TONES[color];
  return isHexAccent(color) ? color : BADGE_TONES.neutral;
}

export function sameBadges(a: TaskBadge[] | undefined, b: TaskBadge[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length
    && x.every((v, i) => v.key === y[i].key && v.text === y[i].text && v.color === y[i].color);
}
