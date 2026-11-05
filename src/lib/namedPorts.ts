// Extra named ports (GH #196): name validation shared by the Repo
// Settings editor (inline warnings) and tests. MIRRORS the Rust
// source of truth (`valid_port_name` / RESERVED_PORT_NAMES in
// src-tauri/src/lib.rs); keep the two lists in sync.

export const RESERVED_PORT_NAMES: ReadonlySet<string> = new Set([
  "TERMIC_PORT", "TERMIC_TASK", "TERMIC_TASK_ID", "TERMIC_TAB_ID", "TERMIC_WORKSPACE_NAME",
  "TERMIC_CLI", "TERMIC_CLI_HELP", "TERMIC_PROJECT_ROOT", "CONDUCTOR_PORT", "CONDUCTOR_WORKSPACE_NAME",
  "PORT", "PATH", "HOME", "SHELL", "USER", "TMPDIR", "PWD", "TERM", "LANG",
  "COLORFGBG", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
  "TMUX", "STY", "ZELLIJ", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR",
  "WEZTERM_PANE", "WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID", "WT_SESSION",
]);

/** A usable extra-named-port env var name: `[A-Za-z_][A-Za-z0-9_]*`,
 *  not reserved, and not in the `TERMIC_PORT_<DIR>` sibling-port
 *  namespace (multi-repo member dirs own it). Names are used verbatim
 *  (free text, no case transformation). */
export function isValidPortName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && !RESERVED_PORT_NAMES.has(name)
    && !name.startsWith("TERMIC_PORT_");
}
