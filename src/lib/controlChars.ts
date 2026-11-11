/** Text that lands in a bracketed paste to an agent's PTY: a control byte in
 *  it (ESC[201~ ends the paste early, then the rest, \r included, lands as
 *  live keystrokes) is worse than a lost character. Strips C0/C1 except \n
 *  and \t, the only ones a composed prompt uses. */
export function stripControl(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
