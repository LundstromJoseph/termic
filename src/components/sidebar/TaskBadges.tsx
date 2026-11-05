import type { CSSProperties } from "react";
import { badgeColor } from "@/lib/taskBadges";
import type { TaskBadge } from "@/lib/types";

/** The badge line under a task's title (`termic badge`). Key, text and colour
 *  are agent data, so nothing here is translated. */
export function TaskBadges({ badges }: { badges: TaskBadge[] }) {
  return (
    // pl-[22px]: the 18px chevron plus the title line's gap-1, so badges start under the name.
    <div data-testid="task-badges" className="flex flex-wrap gap-1 pb-1 pl-[22px]">
      {badges.map(b => (
        <span
          key={b.key}
          data-testid="task-badge"
          data-badge-key={b.key}
          data-badge-color={b.color}
          title={`${b.key}: ${b.text}`}
          className="termic-badge max-w-full truncate rounded px-1.5 text-[11px] leading-4"
          style={{ "--badge": badgeColor(b.color) } as CSSProperties}
        >
          {b.text}
        </span>
      ))}
    </div>
  );
}
