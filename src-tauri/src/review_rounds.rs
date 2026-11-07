//! Review rounds: the hidden refs that keep every round's commits readable
//! after an amend or rebase, and re-anchoring threads from one round's head
//! to the next.
//!
//! Refs live at `refs/termic/reviews/<task_id>/<review_id>/<N>/{base,head}`.
//! The task id is in the path because review ids restart at r1 per task and
//! every worktree of a repo shares `refs/`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

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

/// Round `from` of `r` as the left end of a view whose right end is round
/// `to` (the latest when None). It must come before that round.
pub(crate) fn from_round(r: &Review, from: u32, to: Option<u32>) -> Result<&ReviewRound, String> {
    let n = to.unwrap_or(r.rounds.len() as u32);
    if from == 0 || from >= n {
        return Err(format!("round {from} of {} is not before round {n}", r.id));
    }
    round(r, Some(from))
}

/// A review diff scope after `review:`: `<id>[:from:<K>][:to:<N>]`.
pub(crate) fn parse_scope(rest: &str) -> Result<(&str, Option<u32>, Option<u32>), String> {
    let bad = || format!("review:{rest} is not a review scope");
    let num = |n: Option<&str>| -> Result<u32, String> {
        let n = n.ok_or_else(bad)?;
        if !n.starts_with(|c: char| ('1'..='9').contains(&c)) || !n.chars().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        n.parse().map_err(|_| bad())
    };
    let mut parts = rest.split(':');
    let id = parts.next().unwrap_or_default();
    let mut key = parts.next();
    let mut from = None;
    let mut to = None;
    if key == Some("from") {
        from = Some(num(parts.next())?);
        key = parts.next();
    }
    if key == Some("to") {
        to = Some(num(parts.next())?);
        key = parts.next();
    }
    match key {
        None => Ok((id, from, to)),
        Some(_) => Err(bad()),
    }
}

/// Round K's change replayed onto round N's base, the left side of a
/// "Round K -> N" view, so a rebase between the two rounds does not show
/// upstream's changes as the author's.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Replay {
    /// `left` is the replayed tree, or K's head when both rounds share a base.
    /// A `conflicted` path's tree side holds conflict markers, so its left
    /// side is K's head instead and its diff includes upstream changes.
    Clean { left: String, conflicted: HashSet<String> },
    /// This git cannot replay (merge-tree --merge-base needs 2.40) or the
    /// merge failed in a way that names no file.
    Unavailable,
}

type ReplayKey = (PathBuf, String, String, String);

/// Replayed trees by repo and the three shas. Not pinned by any ref, so gc
/// prunes a tree after gc.pruneExpire; a hit is checked and recomputed then.
static REPLAYS: LazyLock<Mutex<HashMap<ReplayKey, (String, Vec<String>)>>> = LazyLock::new(Default::default);
const REPLAYS_MAX: usize = 64;

pub(crate) fn replay(cwd: &Path, k_base: &str, k_head: &str, n_base: &str) -> Replay {
    if k_base == n_base {
        return Replay::Clean { left: k_head.to_string(), conflicted: HashSet::new() };
    }
    let key = (cwd.to_path_buf(), k_base.to_string(), k_head.to_string(), n_base.to_string());
    let clean = |(tree, conflicted): (String, Vec<String>)| Replay::Clean { left: tree, conflicted: conflicted.into_iter().collect() };
    let hit = REPLAYS.lock().unwrap().get(&key).cloned();
    if let Some(hit) = hit {
        if crate::git_output(&["cat-file", "-e", &hit.0], cwd, None).is_ok_and(|o| o.status.success()) {
            return clean(hit);
        }
    }
    let merge_base = format!("--merge-base={k_base}");
    let Ok(out) = crate::git_output(&["merge-tree", "--write-tree", "-z", "--name-only", &merge_base, n_base, k_head], cwd, None) else {
        return Replay::Unavailable;
    };
    let Some(result) = merge_tree_result(out.status.code(), &out.stdout) else { return Replay::Unavailable };
    let mut memo = REPLAYS.lock().unwrap();
    if memo.len() >= REPLAYS_MAX {
        memo.clear();
    }
    memo.insert(key, result.clone());
    clean(result)
}

/// 0 is clean, 1 is conflicted; anything else (129: an option this git does
/// not know) is no result at all.
fn merge_tree_result(code: Option<i32>, stdout: &[u8]) -> Option<(String, Vec<String>)> {
    match code {
        Some(0) => parse_merge_tree(stdout),
        // A conflict that names no file (a directory rename) cannot fall back per file.
        Some(1) => parse_merge_tree(stdout).filter(|(_, c)| !c.is_empty()),
        _ => None,
    }
}

/// `git merge-tree --write-tree -z --name-only` output: the tree oid, then
/// the conflicted paths up to the first empty field.
fn parse_merge_tree(stdout: &[u8]) -> Option<(String, Vec<String>)> {
    let text = std::str::from_utf8(stdout).ok()?;
    let mut fields = text.split('\0');
    let tree = fields.next()?;
    if tree.is_empty() || !tree.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let conflicted = fields.take_while(|f| !f.is_empty()).map(str::to_string).collect();
    Some((tree.to_string(), conflicted))
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
    fn parse_scope_reads_an_id_with_optional_from_and_to_rounds_in_that_order() {
        assert_eq!(parse_scope("r1"), Ok(("r1", None, None)));
        assert_eq!(parse_scope("r1:to:2"), Ok(("r1", None, Some(2))));
        assert_eq!(parse_scope("r1:from:1"), Ok(("r1", Some(1), None)));
        assert_eq!(parse_scope("r1:from:1:to:3"), Ok(("r1", Some(1), Some(3))));
        for bad in ["r1:to:0", "r1:to:", "r1:to:01", "r1:from", "r1:to:x", "r1:to:2:from:1", "r1:from:1:to:2:x"] {
            assert!(parse_scope(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parse_merge_tree_reads_the_tree_and_the_conflicted_paths_before_the_messages() {
        let tree = "3531".repeat(10);

        let clean = parse_merge_tree(format!("{tree}\0").as_bytes());
        let conflicted = parse_merge_tree(format!("{tree}\0a.txt\0sub/b.txt\0\x001\0a.txt\0Auto-merging\0").as_bytes());
        let garbage = parse_merge_tree(b"usage: git merge-tree\n");

        assert_eq!(clean, Some((tree.clone(), vec![])));
        assert_eq!(conflicted, Some((tree, vec!["a.txt".to_string(), "sub/b.txt".to_string()])));
        assert_eq!(garbage, None);
    }

    #[test]
    fn merge_tree_result_takes_exit_0_and_exit_1_with_named_conflicts_and_nothing_else() {
        let tree = "ab12".repeat(10);
        let clean = format!("{tree}\0");
        let conflicted = format!("{tree}\0a.txt\0\0");

        assert_eq!(merge_tree_result(Some(0), clean.as_bytes()), Some((tree.clone(), vec![])));
        assert_eq!(merge_tree_result(Some(1), conflicted.as_bytes()), Some((tree, vec!["a.txt".to_string()])));
        assert_eq!(merge_tree_result(Some(1), clean.as_bytes()), None, "a conflict that names no file");
        assert_eq!(merge_tree_result(Some(129), b"error: unknown option `merge-base'"), None);
        assert_eq!(merge_tree_result(None, clean.as_bytes()), None, "killed by a signal");
    }

    #[test]
    fn replay_with_the_same_base_on_both_rounds_is_round_ks_head_without_running_git() {
        // A cwd that does not exist: any git call would fail.
        let r = replay(Path::new("/nonexistent/termic-replay"), "base", "khead", "base");

        assert_eq!(r, Replay::Clean { left: "khead".into(), conflicted: HashSet::new() });
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").args(args).current_dir(repo).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(repo: &Path, name: &str, content: &str) -> String {
        std::fs::write(repo.join(name), content).unwrap();
        git(repo, &["add", "."]);
        git(repo, &["commit", "-q", "-m", name]);
        git(repo, &["rev-parse", "HEAD"])
    }

    /// k_base holds a.txt; k_head edits it; n_base adds up.txt on k_base.
    fn replay_repo() -> (tempfile::TempDir, String, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "t@t"), ("core.autocrlf", "false")] {
            git(p, &["config", k, v]);
        }
        let k_base = commit(p, "a.txt", "a\n");
        let k_head = commit(p, "a.txt", "a2\n");
        git(p, &["checkout", "-q", &k_base]);
        let n_base = commit(p, "up.txt", "up\n");
        (dir, k_base, k_head, n_base)
    }

    #[test]
    fn replay_writes_round_ks_change_onto_the_new_base_and_recomputes_a_memoized_tree_gc_pruned() {
        let (dir, k_base, k_head, n_base) = replay_repo();
        let cwd = dir.path();
        let gone = "0123".repeat(10);
        let key = (cwd.to_path_buf(), k_base.clone(), k_head.clone(), n_base.clone());
        REPLAYS.lock().unwrap().insert(key.clone(), (gone.clone(), vec![]));

        let r = replay(cwd, &k_base, &k_head, &n_base);

        let Replay::Clean { left, conflicted } = r else { panic!("expected a clean replay, got {r:?}") };
        assert_ne!(left, gone, "a memoized tree that is gone is recomputed");
        assert!(conflicted.is_empty());
        assert_eq!(git(cwd, &["show", &format!("{left}:a.txt")]), "a2", "round K's change");
        assert_eq!(git(cwd, &["show", &format!("{left}:up.txt")]), "up", "on the new base");
        assert_eq!(REPLAYS.lock().unwrap().get(&key).map(|v| v.0.clone()), Some(left));
    }

    fn review_with_rounds(n: usize) -> Review {
        let round = ReviewRound { base: "b".into(), head: "h".into(), base_ref: "b".into(), head_ref: "h".into(), at: String::new() };
        Review {
            version: 1, id: "r1".into(), task_id: "t1".into(), dir_name: String::new(), base: "b".into(), head: "h".into(),
            base_ref: "b".into(), head_ref: "h".into(), title: None, author: "claude".into(), recipient_tab: None,
            created_at: String::new(), seq: 0, files: vec![], files_truncated: false, threads: vec![],
            rounds: vec![round; n], default_from: None,
        }
    }

    #[test]
    fn from_round_takes_only_a_round_before_the_views_right_end() {
        let r = review_with_rounds(3);

        assert!(from_round(&r, 1, None).is_ok());
        assert!(from_round(&r, 2, None).is_ok());
        assert!(from_round(&r, 1, Some(2)).is_ok());
        assert_eq!(from_round(&r, 3, None).err().as_deref(), Some("round 3 of r1 is not before round 3"));
        assert!(from_round(&r, 2, Some(2)).is_err());
        assert!(from_round(&r, 0, None).is_err());
    }
}
