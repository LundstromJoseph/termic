//! Review rounds: the hidden refs that keep every round's commits readable
//! after an amend or rebase, and re-anchoring threads from one round's head
//! to the next.
//!
//! Refs live at `refs/termic/reviews/<task_id>/<review_id>/<N>/{base,head}`.
//! The task id is in the path because review ids restart at r1 per task and
//! every worktree of a repo shares `refs/`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use termic_proto::{Review, ReviewOutdated, ReviewRound, ReviewThread};

fn prefix(task_id: &str, review_id: &str) -> String {
    format!("refs/termic/reviews/{task_id}/{review_id}/")
}

/// Points round `n`'s two refs at `base` and `head`, in one transaction.
pub(crate) fn pin(cwd: &Path, task_id: &str, review_id: &str, n: usize, base: &str, head: &str) -> Result<(), String> {
    let p = prefix(task_id, review_id);
    let input = format!("update {p}{n}/base {base}\nupdate {p}{n}/head {head}\n");
    let out = crate::git_output(&["update-ref", "--stdin"], cwd, Some(input.as_bytes())).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("pinning round {n} of {review_id} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub(crate) fn pinned(cwd: &Path, task_id: &str, review_id: &str, n: usize) -> bool {
    let r = format!("{}{n}/head", prefix(task_id, review_id));
    crate::git_output(&["rev-parse", "--verify", "--quiet", &r], cwd, None).is_ok_and(|o| o.status.success())
}

/// Deletes every review ref of `task_id` in each of `repos`. Best effort: a
/// repo that is gone or refuses is logged and skipped.
pub(crate) fn drop_task_refs(task_id: &str, repos: &[PathBuf]) {
    if !crate::scratch_id_ok(task_id) {
        return;
    }
    let p = format!("refs/termic/reviews/{task_id}/");
    for repo in repos {
        let Ok(list) = crate::git(&["for-each-ref", "--format=%(refname)", &p], repo) else {
            eprintln!("[reviews] listing {p} in {} failed", repo.display());
            continue;
        };
        let input: String = list.lines().filter(|l| !l.is_empty()).map(|l| format!("delete {l}\n")).collect();
        if input.is_empty() {
            continue;
        }
        match crate::git_output(&["update-ref", "--stdin"], repo, Some(input.as_bytes())) {
            Ok(o) if o.status.success() => {}
            Ok(o) => eprintln!("[reviews] deleting {p} in {} failed: {}", repo.display(), String::from_utf8_lossy(&o.stderr)),
            Err(e) => eprintln!("[reviews] deleting {p} in {} failed: {e}", repo.display()),
        }
    }
}

/// Round `n` of `r`, the latest when None.
pub(crate) fn round(r: &Review, n: Option<u32>) -> Result<&ReviewRound, String> {
    match n {
        None => r.rounds.last().ok_or_else(|| format!("review {} has no rounds", r.id)),
        Some(n) => (n as usize)
            .checked_sub(1)
            .and_then(|i| r.rounds.get(i))
            .ok_or_else(|| format!("review {} has no round {n}", r.id)),
    }
}

/// A review diff scope after `review:`: `<id>` or `<id>:to:<N>`.
pub(crate) fn parse_scope(rest: &str) -> Result<(&str, Option<u32>), String> {
    let bad = || format!("review:{rest} is not a review scope");
    match rest.split_once(':') {
        None => Ok((rest, None)),
        Some((id, tail)) => {
            let n = tail.strip_prefix("to:").ok_or_else(bad)?;
            if !n.starts_with(|c: char| ('1'..='9').contains(&c)) || !n.chars().all(|c| c.is_ascii_digit()) {
                return Err(bad());
            }
            Ok((id, Some(n.parse().map_err(|_| bad())?)))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Hunk {
    old_start: u32,
    old_len: u32,
    new_len: u32,
}

/// The hunks of a `git diff -U0`. None when the output has no hunk header
/// although something differs, which is a binary file.
fn parse_hunks(diff: &str) -> Option<Vec<Hunk>> {
    if diff.trim().is_empty() {
        return Some(Vec::new());
    }
    // "@@ -a[,b] +c[,d] @@"; an omitted length is 1.
    let side = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let hunks: Vec<Hunk> = diff
        .lines()
        .filter_map(|l| {
            let mut parts = l.strip_prefix("@@ -")?.split(' ');
            let (old_start, old_len) = side(parts.next()?)?;
            let (_, new_len) = side(parts.next()?.strip_prefix('+')?)?;
            Some(Hunk { old_start, old_len, new_len })
        })
        .collect();
    (!hunks.is_empty()).then_some(hunks)
}

/// Lines `s..=e` on the old side, moved past `hunks`. None when a hunk
/// touches the range or inserts inside it: the thread goes outdated.
fn shift(hunks: &[Hunk], s: u32, e: u32) -> Option<(u32, u32)> {
    let mut offset: i64 = 0;
    for h in hunks {
        let a = h.old_start;
        if h.old_len == 0 {
            // An insertion after old line `a`.
            if a < s {
                offset += h.new_len as i64;
            } else if a < e {
                return None;
            } else {
                break;
            }
        } else {
            let old_end = a + h.old_len - 1;
            if old_end < s {
                offset += h.new_len as i64 - h.old_len as i64;
            } else if a > e {
                break;
            } else {
                return None;
            }
        }
    }
    Some(((s as i64 + offset) as u32, (e as i64 + offset) as u32))
}

/// `git diff --name-status -M -z` as old path -> (status letter, new path).
/// Unlike `parse_name_status_z`, which keeps only the new path, this keeps
/// both ends of a rename.
fn parse_moves(out: &str) -> HashMap<String, (char, String)> {
    let f: Vec<&str> = out.split('\0').collect();
    let mut moves = HashMap::new();
    let mut i = 0;
    while let Some(status) = f.get(i).filter(|s| !s.is_empty()) {
        let letter = status.chars().next().unwrap();
        let two = matches!(letter, 'R' | 'C');
        let (Some(old), Some(new)) = (f.get(i + 1), f.get(if two { i + 2 } else { i + 1 })) else { break };
        moves.insert(old.to_string(), (letter, new.to_string()));
        i += if two { 3 } else { 2 };
    }
    moves
}

/// Moves each live thread from `old_head` to `new_head`: renames follow, line
/// threads shift past changes above them, and anything whose lines or file
/// changed goes outdated in `round`. Returns the threads it outdated, at
/// their anchor before the move. Never touches `resolved`.
pub(crate) fn reanchor(
    cwd: &Path,
    old_head: &str,
    new_head: &str,
    threads: &mut [ReviewThread],
    new_files: &HashSet<String>,
    round: u32,
) -> Result<Vec<ReviewOutdated>, String> {
    let names = crate::git(&["--no-pager", "diff", "--name-status", "-M", "-z", "--relative", old_head, new_head], cwd)
        .map_err(|e| e.to_string())?;
    let moves = parse_moves(&names);
    let mut hunks: HashMap<String, Option<Vec<Hunk>>> = HashMap::new();
    let mut outdated = Vec::new();
    for th in threads.iter_mut().filter(|t| t.outdated.is_none()) {
        let lines = th.start_line.zip(th.end_line);
        let moved = match moves.get(&th.file) {
            None => Some((th.file.clone(), lines)),
            Some((letter, new)) if matches!(letter, 'M' | 'T' | 'R') => {
                let key = format!("{}\0{new}", th.file);
                if !hunks.contains_key(&key) {
                    let diff = crate::git(
                        &[
                            "--no-pager", "diff", "-U0", "--no-color", "--no-ext-diff",
                            &format!("{old_head}:./{}", th.file),
                            &format!("{new_head}:./{new}"),
                        ],
                        cwd,
                    )
                    .map_err(|e| e.to_string())?;
                    hunks.insert(key.clone(), parse_hunks(&diff));
                }
                match (lines, &hunks[&key]) {
                    (None, _) => Some((new.clone(), None)),
                    (Some(_), None) => None,
                    (Some((s, e)), Some(h)) => shift(h, s, e).map(|l| (new.clone(), Some(l))),
                }
            }
            Some(_) => None,
        };
        // A file that left the range has no diff to draw the thread in.
        match moved.filter(|(file, _)| new_files.contains(file)) {
            Some((file, lines)) => {
                let now = (file, lines.map(|l| l.0), lines.map(|l| l.1));
                if now != (th.file.clone(), th.start_line, th.end_line) {
                    if th.origin.is_none() {
                        th.origin = Some(th.origin_anchor());
                    }
                    (th.file, th.start_line, th.end_line) = now;
                }
            }
            None => {
                outdated.push(ReviewOutdated {
                    thread_id: th.id.clone(),
                    file: th.file.clone(),
                    start_line: th.start_line,
                    end_line: th.end_line,
                });
                th.outdated = Some(round);
            }
        }
    }
    Ok(outdated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(old_start: u32, old_len: u32, new_len: u32) -> Hunk {
        Hunk { old_start, old_len, new_len }
    }

    #[test]
    fn shift_moves_a_range_past_inserts_and_deletes_above_it_and_outdates_one_a_hunk_touches() {
        // Two lines inserted after line 0 (the top), one deleted at line 3.
        assert_eq!(shift(&[h(0, 0, 2)], 5, 6), Some((7, 8)), "insert at the top");
        assert_eq!(shift(&[h(2, 0, 3)], 5, 6), Some((8, 9)), "insert above");
        assert_eq!(shift(&[h(3, 1, 0)], 5, 6), Some((4, 5)), "delete above");
        assert_eq!(shift(&[h(3, 2, 1), h(9, 0, 4)], 5, 6), Some((4, 5)), "a hunk below does not count");
        assert_eq!(shift(&[h(5, 1, 1)], 5, 6), None, "change inside");
        assert_eq!(shift(&[h(4, 3, 1)], 5, 6), None, "change overlapping the start");
        assert_eq!(shift(&[h(5, 0, 1)], 5, 6), None, "insert between the two lines");
        assert_eq!(shift(&[h(6, 0, 1)], 5, 6), Some((5, 6)), "insert right after the end");
        assert_eq!(shift(&[h(7, 1, 1)], 5, 6), Some((5, 6)), "change right after the end");
        assert_eq!(shift(&[], 5, 6), Some((5, 6)));
    }

    #[test]
    fn parse_hunks_reads_headers_with_omitted_lengths_as_one_and_a_binary_diff_as_none() {
        let multi = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n@@ -4 +6 @@ ctx\n-x\n+y\n@@ -9,2 +10,0 @@\n-p\n-q\n";

        assert_eq!(parse_hunks(""), Some(vec![]));
        assert_eq!(parse_hunks(multi), Some(vec![h(0, 0, 2), h(4, 1, 1), h(9, 2, 0)]));
        assert_eq!(parse_hunks("diff --git a/x b/x\nBinary files a/x and b/x differ\n"), None);
    }

    #[test]
    fn parse_moves_keys_by_the_old_path_and_keeps_both_ends_of_a_rename() {
        let out = "R100\0old.rs\0new.rs\0R087\0a/b.rs\0a/c.rs\0D\0gone.rs\0M\0kept.rs\0";

        let m = parse_moves(out);

        assert_eq!(m["old.rs"], ('R', "new.rs".into()));
        assert_eq!(m["a/b.rs"], ('R', "a/c.rs".into()));
        assert_eq!(m["gone.rs"], ('D', "gone.rs".into()));
        assert_eq!(m["kept.rs"], ('M', "kept.rs".into()));
        assert_eq!(m.len(), 4);
    }

    #[test]
    fn parse_scope_reads_an_id_with_an_optional_to_round() {
        assert_eq!(parse_scope("r1"), Ok(("r1", None)));
        assert_eq!(parse_scope("r1:to:2"), Ok(("r1", Some(2))));
        for bad in ["r1:to:0", "r1:to:", "r1:to:01", "r1:from:1", "r1:to:x"] {
            assert!(parse_scope(bad).is_err(), "{bad}");
        }
    }
}
