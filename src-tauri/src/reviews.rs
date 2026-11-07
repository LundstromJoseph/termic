//! Agent-presented reviews: one JSON file per review at
//! `scratch/<task_id>/reviews/<id>.json`. Rust is the only writer, and every
//! read-modify-write holds `REVIEW_LOCK`, whether it comes from a CLI server
//! thread or a Tauri command. Reads take no lock: `write_atomic` never
//! exposes a torn file.
//!
//! A review has rounds. `present new` opens round 1; `present update` after
//! an amend, rebase or new commit adds the next, and the top-level range and
//! files mirror the latest. Each round's base and head are pinned by hidden
//! refs (see `review_rounds`), so a rebased-away round stays readable. On an
//! update, threads move from the old head to the new one: a line thread in
//! an unchanged stretch shifts, renames follow, and anything else is marked
//! outdated in that round and stays at its last live anchor.
//!
//! The folder lives inside the task's scratch dir, so `delete_task_file`'s
//! purge removes it and archiving leaves it alone, like the task's pads.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use termic_proto::{
    review_author_problem, review_body_problem, review_id_problem, review_range_problem,
    review_thread_id_problem, review_title_problem, split_thread_id, Review, ReviewBy, ReviewComment,
    ReviewOutdated, ReviewResolved, ReviewRound, ReviewThread,
    REVIEW_COMMENTS_PER_THREAD_MAX, REVIEW_QUOTE_MAX, REVIEW_ROUNDS_MAX, REVIEW_THREADS_MAX,
};

use crate::Task;

static REVIEW_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub(crate) struct NewReview {
    /// `A..B` as the agent typed it.
    pub range: String,
    pub title: Option<String>,
    pub author: String,
    pub recipient_tab: Option<String>,
    pub dir_name: String,
}

/// `present update`: the next round's head, and its base when not the last
/// round's base_ref resolved again. `show` None keeps `default_from`.
pub(crate) struct NewRound {
    pub head: String,
    pub base: Option<String>,
    pub show: Option<Option<u32>>,
}

pub(crate) enum ReviewOp {
    /// Opens a thread. `lines` None is a file-level thread. `quote` Some is
    /// the text the UI already shows; None reads it from the head commit.
    /// `round` Some is the round the user wrote it on, refused once stale.
    Comment {
        file: String,
        lines: Option<(u32, u32)>,
        body: String,
        by: ReviewBy,
        author: String,
        quote: Option<String>,
        round: Option<u32>,
    },
    Reply { thread_id: String, body: String, by: ReviewBy, author: String },
    Claim { tab: String, author: Option<String> },
    Resolve { thread_id: String, resolved: bool, by: ReviewBy },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct Posted {
    pub thread_id: String,
    pub seq: u64,
    pub new_thread: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ReviewError {
    NoSuchReview(String),
    NoSuchThread(String),
    Invalid(String),
    Git(String),
    Io(String),
}

impl std::fmt::Display for ReviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSuchReview(id) => write!(f, "no such review {id}"),
            Self::NoSuchThread(id) => write!(f, "no such thread {id}"),
            Self::Invalid(m) | Self::Git(m) | Self::Io(m) => f.write_str(m),
        }
    }
}

/// One comment the user posts from a review diff: a reply when `thread_id`
/// is set, otherwise a new thread on `file` (file-level without lines).
#[derive(serde::Deserialize)]
pub(crate) struct ReviewPostItem {
    pub thread_id: Option<String>,
    pub file: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub quote: Option<String>,
    pub body: String,
    /// The round the new thread was written on.
    #[serde(default)]
    pub round: Option<u32>,
}

#[derive(serde::Serialize)]
pub(crate) struct ReviewPostResult {
    pub review: Review,
    pub posted: Vec<Posted>,
}

/// The user's side of `apply`. No push: the webview applies the returned review.
pub(crate) fn post(task: &Task, review_id: &str, items: Vec<ReviewPostItem>) -> Result<ReviewPostResult, ReviewError> {
    let ops = items
        .into_iter()
        .map(|i| match (i.thread_id, i.file) {
            (Some(thread_id), _) => Ok(ReviewOp::Reply { thread_id, body: i.body, by: ReviewBy::User, author: String::new() }),
            (None, None) => Err(ReviewError::Invalid("a new thread needs a file".into())),
            (None, Some(_)) if i.start_line.is_none() && i.end_line.is_some() => {
                Err(ReviewError::Invalid("end_line without start_line".into()))
            }
            (None, Some(file)) => Ok(ReviewOp::Comment {
                file,
                lines: i.start_line.map(|s| (s, i.end_line.unwrap_or(s))),
                body: i.body,
                by: ReviewBy::User,
                author: String::new(),
                quote: i.quote,
                round: i.round,
            }),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (review, posted, _) = apply(task, review_id, ops)?;
    Ok(ReviewPostResult { review, posted })
}

/// `<profile>/scratch/<task_id>/reviews`, from the task's own profile tag.
/// Not `scratch_dir`: that re-reads every task file to find the profile, and
/// creates the folder, which a read must not.
fn reviews_dir(task: &Task) -> Result<PathBuf, ReviewError> {
    if !crate::scratch_id_ok(&task.id) {
        return Err(ReviewError::Invalid(format!("invalid task id: {:?}", task.id)));
    }
    let base = crate::profile_dir(&task.profile).map_err(|e| ReviewError::Io(e.to_string()))?;
    Ok(base.join("scratch").join(&task.id).join("reviews"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// The N of every `r<N>.json` in `dir`, unsorted.
fn numbers(dir: &Path) -> Vec<u64> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let id = name.to_str()?.strip_suffix(".json")?;
            review_id_problem(id).is_none().then(|| id[1..].parse().ok()).flatten()
        })
        .collect()
}

fn write(dir: &Path, review: &Review) -> Result<(), ReviewError> {
    fs::create_dir_all(dir).map_err(|e| ReviewError::Io(format!("create reviews dir failed: {e}")))?;
    let json = serde_json::to_string_pretty(review).map_err(|e| ReviewError::Io(e.to_string()))?;
    crate::write_atomic(&dir.join(format!("{}.json", review.id)), json.as_bytes())
        .map_err(|e| ReviewError::Io(format!("review write failed: {e}")))
}

fn trimmed(s: &str) -> String {
    s.trim().to_string()
}

/// A rev as an agent types it (`main`, `HEAD~3`, `abc123^`) to its full
/// commit sha. Laxer than `resolve_rev`, which refuses `~` and `^` because
/// Compare only passes refnames; `--end-of-options` and the leading-dash
/// check keep it an argument, never an option.
fn resolve_commit(cwd: &Path, rev: &str) -> Result<String, ReviewError> {
    let bad = || ReviewError::Invalid(format!("{rev} isn't a commit in this repo"));
    if rev.starts_with('-') || rev.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad());
    }
    let sha = crate::git(&["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^{{commit}}")], cwd)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if sha.is_empty() {
        Err(bad())
    } else {
        Ok(sha)
    }
}

/// The merge-base of `tip` and `head`, as task_diff and Compare diff:
/// `main..HEAD` must not list what main gained after the branch left it.
/// Unrelated histories have none, so they diff from the tip.
fn range_base(cwd: &Path, tip: String, head: &str) -> String {
    crate::git(&["merge-base", &tip, head], cwd)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(tip)
}

/// The changed paths of `base..head`, sorted and capped, and whether the cap cut any.
fn range_files(cwd: &Path, base: &str, head: &str) -> (Vec<String>, bool) {
    let mut files: Vec<String> =
        crate::tracked_diff_files(cwd, &[base, head], false).into_iter().map(|f| f.path).collect();
    files.sort();
    let truncated = files.len() > crate::MAX_COMPARE_FILES;
    files.truncate(crate::MAX_COMPARE_FILES);
    (files, truncated)
}

pub(crate) fn create(task: &Task, req: NewReview) -> Result<Review, ReviewError> {
    let problem = review_range_problem(&req.range)
        .or_else(|| req.title.as_deref().and_then(review_title_problem))
        .or_else(|| review_author_problem(&req.author));
    if let Some(p) = problem {
        return Err(ReviewError::Invalid(p));
    }
    let cwd = crate::repo_cwd(task, &req.dir_name).map_err(ReviewError::Invalid)?;
    let (base_ref, head_ref) = req.range.split_once("..").expect("validated above");
    let tip = resolve_commit(&cwd, base_ref)?;
    let head = resolve_commit(&cwd, head_ref)?;
    let base = range_base(&cwd, tip, &head);
    let (files, files_truncated) = range_files(&cwd, &base, &head);
    // A review with no files could never take a comment.
    if files.is_empty() {
        return Err(ReviewError::Invalid(format!("nothing changed in {base_ref}..{head_ref}")));
    }

    let dir = reviews_dir(task)?;
    let _g = REVIEW_LOCK.lock();
    // Numbered from file NAMES, so a corrupt r3.json still holds r3.
    let last = numbers(&dir).into_iter().max().unwrap_or(0);
    let id = format!("r{}", last + 1);
    crate::review_rounds::pin(&cwd, &task.id, &id, 1, &base, &head).map_err(ReviewError::Git)?;
    let created_at = now();
    let review = Review {
        version: 1,
        id,
        task_id: task.id.clone(),
        dir_name: req.dir_name,
        rounds: vec![ReviewRound {
            base: base.clone(),
            head: head.clone(),
            base_ref: base_ref.to_string(),
            head_ref: head_ref.to_string(),
            at: created_at.clone(),
        }],
        default_from: None,
        base,
        head,
        base_ref: base_ref.to_string(),
        head_ref: head_ref.to_string(),
        title: req.title.as_deref().map(trimmed).filter(|t| !t.is_empty()),
        author: trimmed(&req.author),
        recipient_tab: req.recipient_tab,
        created_at,
        seq: 0,
        files,
        files_truncated,
        threads: Vec::new(),
    };
    write(&dir, &review)?;
    Ok(review)
}

pub(crate) fn load(task: &Task, id: &str) -> Result<Review, ReviewError> {
    if let Some(p) = review_id_problem(id) {
        return Err(ReviewError::Invalid(p));
    }
    read(&reviews_dir(task)?, id)
}

fn read(dir: &Path, id: &str) -> Result<Review, ReviewError> {
    let path = dir.join(format!("{id}.json"));
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReviewError::NoSuchReview(id.to_string()))
        }
        Err(e) => return Err(ReviewError::Io(format!("{}: {e}", path.display()))),
    };
    let mut review: Review =
        serde_json::from_str(&text).map_err(|e| ReviewError::Io(format!("{}: {e}", path.display())))?;
    // Written before rounds: its one range is round 1.
    if review.rounds.is_empty() {
        review.rounds.push(ReviewRound {
            base: review.base.clone(),
            head: review.head.clone(),
            base_ref: review.base_ref.clone(),
            head_ref: review.head_ref.clone(),
            at: review.created_at.clone(),
        });
    }
    // `write` names the file after the record's id, so a mismatched copy
    // would overwrite a different review on its next write.
    if review.id != id {
        return Err(ReviewError::Io(format!("{} holds review {}", path.display(), review.id)));
    }
    // The stored shas reach git as revs, so a hand-edited file must not slip in a flag.
    if !review.rounds.iter().all(|r| crate::is_commit_ish(&r.base) && crate::is_commit_ish(&r.head)) {
        return Err(ReviewError::Io(format!("{}: review rounds must be commit shas", path.display())));
    }
    Ok(review)
}

/// Every review of the task, by number. An unreadable file is skipped, not
/// fatal: one torn file must not hide the rest.
pub(crate) fn list(task: &Task) -> Vec<Review> {
    let Ok(dir) = reviews_dir(task) else { return Vec::new() };
    let mut numbers = numbers(&dir);
    numbers.sort_unstable();
    numbers
        .into_iter()
        .filter_map(|n| match read(&dir, &format!("r{n}")) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("[reviews] skipping r{n} of {}: {e:?}", task.id);
                None
            }
        })
        .collect()
}

/// Applies `ops` in order to one review and writes it once, only if it
/// changed. All or nothing: the first invalid op fails the whole batch and
/// nothing is written.
pub(crate) fn apply(task: &Task, review_id: &str, ops: Vec<ReviewOp>) -> Result<(Review, Vec<Posted>, bool), ReviewError> {
    if let Some(p) = review_id_problem(review_id) {
        return Err(ReviewError::Invalid(p));
    }
    let dir = reviews_dir(task)?;
    // Quotes are read BEFORE the lock: a git process per comment must not
    // hold up every other task's review writes. A round can start meanwhile,
    // which the head check below catches.
    let (ops, quoted_at) = with_quotes(task, &read(&dir, review_id)?, ops)?;
    let _g = REVIEW_LOCK.lock();
    let stored = read(&dir, review_id)?;
    let latest = stored.rounds.len() as u32;
    if quoted_at.is_some_and(|h| h != stored.head) {
        return Err(ReviewError::Invalid(format!(
            "review {review_id} moved to round {latest} while this comment was posted; comment on the new round"
        )));
    }
    let mut r = stored.clone();
    let mut posted = Vec::new();
    for op in ops {
        match op {
            ReviewOp::Comment { file, lines, body, by, author, quote, round } => {
                if let Some(k) = round.filter(|k| *k != latest) {
                    return Err(ReviewError::Invalid(format!(
                        "this comment was written on round {k} of {review_id}, which is now on round {latest}; comment on the new diff"
                    )));
                }
                if let Some((start, end)) = lines {
                    if start == 0 || start > end {
                        return Err(ReviewError::Invalid(format!("{start}-{end} is not a line range")));
                    }
                }
                let comment = new_comment(&mut r, by, &author, &body)?;
                if !r.files.contains(&file) {
                    return Err(ReviewError::Invalid(format!("{file} is not changed in {}..{}", r.base_ref, r.head_ref)));
                }
                if r.threads.len() >= REVIEW_THREADS_MAX {
                    return Err(ReviewError::Invalid(format!("review {} already has {REVIEW_THREADS_MAX} threads", r.id)));
                }
                // with_quotes filled `quote` on every line comment that gets here.
                let quote = if lines.is_some() { quote.unwrap_or_default() } else { String::new() };
                let id = format!("{}-t{}", r.id, r.threads.len() + 1);
                posted.push(Posted { thread_id: id.clone(), seq: comment.seq, new_thread: true });
                r.threads.push(ReviewThread {
                    id,
                    file,
                    start_line: lines.map(|l| l.0),
                    end_line: lines.map(|l| l.1),
                    quote: quote.chars().take(REVIEW_QUOTE_MAX).collect(),
                    comments: vec![comment],
                    resolved: None,
                    round: latest,
                    origin: None,
                    outdated: None,
                });
            }
            ReviewOp::Reply { thread_id, body, by, author } => {
                let comment = new_comment(&mut r, by, &author, &body)?;
                let thread = r
                    .threads
                    .iter_mut()
                    .find(|t| t.id == thread_id)
                    .ok_or_else(|| ReviewError::NoSuchThread(thread_id.clone()))?;
                if thread.comments.len() >= REVIEW_COMMENTS_PER_THREAD_MAX {
                    return Err(ReviewError::Invalid(format!(
                        "thread {thread_id} already has {REVIEW_COMMENTS_PER_THREAD_MAX} comments"
                    )));
                }
                posted.push(Posted { thread_id, seq: comment.seq, new_thread: false });
                thread.comments.push(comment);
                // A reply reopens, or it would sit collapsed outside the awaiting count.
                thread.resolved = None;
            }
            ReviewOp::Claim { tab, author } => {
                let before = (r.recipient_tab.clone(), r.author.clone());
                if let Some(a) = author {
                    if let Some(p) = review_author_problem(&a) {
                        return Err(ReviewError::Invalid(p));
                    }
                    r.author = trimmed(&a);
                }
                r.recipient_tab = Some(tab);
                // A claim bumps seq too, so the webview can order every
                // version of the record by seq alone.
                if (&r.recipient_tab, &r.author) != (&before.0, &before.1) {
                    r.seq += 1;
                }
            }
            ReviewOp::Resolve { thread_id, resolved, by } => {
                let author = r.author.clone();
                let thread = r
                    .threads
                    .iter_mut()
                    .find(|t| t.id == thread_id)
                    .ok_or_else(|| ReviewError::NoSuchThread(thread_id.clone()))?;
                if thread.resolved.is_some() != resolved {
                    thread.resolved = resolved.then(|| ReviewResolved {
                        by,
                        author: match by {
                            ReviewBy::Agent => author,
                            ReviewBy::User => String::new(),
                        },
                        at: now(),
                    });
                    r.seq += 1;
                }
            }
        }
    }
    let changed = r != stored;
    if changed {
        write(&dir, &r)?;
    }
    Ok((r, posted, changed))
}

/// Resolves or reopens thread `thread_id` (`r1-t3`). The bool is false when
/// it was already in that state, and then nothing is written.
pub(crate) fn set_resolved(task: &Task, thread_id: &str, resolved: bool, by: ReviewBy) -> Result<(Review, bool), ReviewError> {
    let (review_id, _) = split_thread_id(thread_id)
        .ok_or_else(|| ReviewError::Invalid(review_thread_id_problem(thread_id).unwrap_or_default()))?;
    let (review, _, changed) =
        apply(task, review_id, vec![ReviewOp::Resolve { thread_id: thread_id.into(), resolved, by }])?;
    Ok((review, changed))
}

/// Validates the comment and takes the review's next seq for it.
fn new_comment(r: &mut Review, by: ReviewBy, author: &str, body: &str) -> Result<ReviewComment, ReviewError> {
    let problem = review_body_problem(body).or_else(|| match by {
        ReviewBy::Agent => review_author_problem(author),
        ReviewBy::User => None,
    });
    if let Some(p) = problem {
        return Err(ReviewError::Invalid(p));
    }
    r.seq += 1;
    Ok(ReviewComment { seq: r.seq, by, author: trimmed(author), body: trimmed(body), at: now(), round: r.rounds.len() as u32 })
}

/// Fills `quote` from the head commit on every line comment that has none,
/// reading each file once per batch, and returns the head it read when it
/// read any. An op it cannot quote (bad lines, a file outside the range)
/// passes through untouched for `apply` to refuse.
fn with_quotes(task: &Task, r: &Review, ops: Vec<ReviewOp>) -> Result<(Vec<ReviewOp>, Option<String>), ReviewError> {
    let mut blobs: HashMap<String, Vec<String>> = HashMap::new();
    let ops = ops
        .into_iter()
        .map(|op| match op {
            ReviewOp::Comment { file, lines: Some((start, end)), body, by, author, quote: None, round }
                if start >= 1 && start <= end && r.files.contains(&file) =>
            {
                if !blobs.contains_key(&file) {
                    blobs.insert(file.clone(), head_file(task, r, &file)?);
                }
                let lines = &blobs[&file];
                if end as usize > lines.len() {
                    return Err(ReviewError::Invalid(format!(
                        "{file} has {} lines at {}, so line {end} does not exist",
                        lines.len(),
                        r.head_ref
                    )));
                }
                let quote = lines[start as usize - 1..end as usize].join("\n");
                Ok(ReviewOp::Comment { file, lines: Some((start, end)), body, by, author, quote: Some(quote), round })
            }
            op => Ok(op),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((ops, (!blobs.is_empty()).then(|| r.head.clone())))
}

/// Starts the review's next round. Threads move to the new head or go
/// outdated; the reply lists the outdated ones where they were opened.
pub(crate) fn update(task: &Task, review_id: &str, req: NewRound) -> Result<(Review, Vec<ReviewOutdated>), ReviewError> {
    let next = prepare_update(task, review_id, req)?;
    finish_update(task, review_id, next)
}

/// What `update` resolves before taking the lock.
struct NextRound {
    snap: Review,
    cwd: PathBuf,
    req: NewRound,
    base: String,
    head: String,
    base_ref: String,
    files: Vec<String>,
    files_truncated: bool,
    moves: crate::review_rounds::Moves,
}

/// Everything that runs git but the per-file diffs, outside the lock like
/// quotes: revs, the file list, and the rename pass, which after a rebase
/// spans all of upstream's churn.
fn prepare_update(task: &Task, review_id: &str, req: NewRound) -> Result<NextRound, ReviewError> {
    if let Some(p) = review_id_problem(review_id) {
        return Err(ReviewError::Invalid(p));
    }
    let snap = read(&reviews_dir(task)?, review_id)?;
    let cwd = crate::repo_cwd(task, &snap.dir_name).map_err(ReviewError::Invalid)?;
    let head = resolve_commit(&cwd, &req.head)?;
    let base_ref = req.base.clone().unwrap_or_else(|| snap.base_ref.clone());
    let base = range_base(&cwd, resolve_commit(&cwd, &base_ref)?, &head);
    let (files, files_truncated) = range_files(&cwd, &base, &head);
    if files.is_empty() {
        return Err(ReviewError::Invalid(format!("nothing changed in {base_ref}..{}", req.head)));
    }
    let last_head = &snap.rounds.last().expect("read fills round 1").head;
    let moves = crate::review_rounds::moves(&cwd, last_head, &head).map_err(ReviewError::Git)?;
    Ok(NextRound { snap, cwd, req, base, head, base_ref, files, files_truncated, moves })
}

fn finish_update(task: &Task, review_id: &str, next: NextRound) -> Result<(Review, Vec<ReviewOutdated>), ReviewError> {
    let NextRound { snap, cwd, req, base, head, base_ref, files, files_truncated, moves } = next;
    let dir = reviews_dir(task)?;
    let _g = REVIEW_LOCK.lock();
    let stored = read(&dir, review_id)?;
    let n = stored.rounds.len() + 1;
    // Also what keeps `moves` valid: same round count, same last head.
    if stored.rounds.len() != snap.rounds.len() {
        return Err(ReviewError::Invalid(format!("review {review_id} moved to round {} meanwhile; update it again", n - 1)));
    }
    if n > REVIEW_ROUNDS_MAX {
        return Err(ReviewError::Invalid(format!("review {review_id} already has {REVIEW_ROUNDS_MAX} rounds")));
    }
    let last = stored.rounds.last().expect("read fills round 1").clone();
    if (last.base.as_str(), last.head.as_str()) == (base.as_str(), head.as_str()) {
        return Err(ReviewError::Invalid(format!(
            "round {} of {review_id} is already {}..{}",
            n - 1,
            last.base_ref,
            last.head_ref
        )));
    }
    if let Some(Some(k)) = req.show {
        if k as usize >= n {
            return Err(ReviewError::Invalid(format!("round {k} is not before round {n}")));
        }
    }
    use crate::review_rounds::{pin, pinned};
    // A review opened before rounds has no refs; best effort, since its
    // commits may already be gone.
    if !pinned(&cwd, &task.id, review_id, 1) {
        let first = &stored.rounds[0];
        let _ = pin(&cwd, &task.id, review_id, 1, &first.base, &first.head);
    }
    pin(&cwd, &task.id, review_id, n, &base, &head).map_err(ReviewError::Git)?;

    let mut r = stored;
    // Under the lock on purpose: the thread set must not change mid-update.
    // That is one `-U0` diff per changed file a line thread sits on, and
    // updates are rare.
    let in_range: HashSet<String> = files.iter().cloned().collect();
    let outdated = crate::review_rounds::reanchor(&cwd, &last.head, &head, &moves, &mut r.threads, &in_range, n as u32);
    r.rounds.push(ReviewRound {
        base: base.clone(),
        head: head.clone(),
        base_ref: base_ref.clone(),
        head_ref: req.head.clone(),
        at: now(),
    });
    (r.base, r.head, r.base_ref, r.head_ref) = (base, head, base_ref, req.head);
    (r.files, r.files_truncated) = (files, files_truncated);
    if let Some(show) = req.show {
        r.default_from = show;
    }
    r.seq += 1;
    write(&dir, &r)?;
    Ok((r, outdated))
}

/// Deletes the task's review refs from every repo it may have pinned them
/// in: the project's and each member's source repo. The task's own worktree
/// may already be gone, and all worktrees share their repo's refs anyway.
pub(crate) fn drop_refs(task: &Task, projects: &[crate::Project]) {
    let mut repos: Vec<PathBuf> = projects
        .iter()
        .filter(|p| p.id == task.project_id && !p.non_git)
        .map(|p| PathBuf::from(&p.root_path))
        .collect();
    repos.extend(task.composition.iter().filter(|m| !m.repo_path.is_empty()).map(|m| PathBuf::from(&m.repo_path)));
    crate::review_rounds::drop_task_refs(&task.id, &repos);
}

/// `file`'s lines as the head commit has it.
fn head_file(task: &Task, r: &Review, file: &str) -> Result<Vec<String>, ReviewError> {
    let cwd = crate::repo_cwd(task, &r.dir_name).map_err(ReviewError::Invalid)?;
    // `./` reads the path relative to cwd, matching the `--relative` file list.
    let text = crate::git(&["show", &format!("{}:./{file}", r.head)], &cwd).map_err(|e| {
        // `file` is in the range, so a head commit that exists but lacks it
        // deleted it. Asked of git rather than read from its (localized) stderr.
        if crate::git(&["cat-file", "-e", &format!("{}^{{commit}}", r.head)], &cwd).is_ok() {
            ReviewError::Invalid(format!("{file} is deleted at {}; comment at file level", r.head_ref))
        } else {
            ReviewError::Git(e.to_string())
        }
    })?;
    Ok(text.lines().map(str::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_scratch_data_dir;
    use std::path::Path;

    fn git(repo: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(repo).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn commit(repo: &Path, name: &str, content: &str) {
        fs::write(repo.join(name), content).unwrap();
        git(repo, &["add", "."]);
        git(repo, &["commit", "-q", "-m", name]);
    }

    /// `base` holds a.txt, same.txt and gone.txt; `main` then edits a.txt (4
    /// lines at head), adds new.txt and deletes gone.txt. So base..main
    /// changes everything but same.txt.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "t@t"), ("core.autocrlf", "false")] {
            git(p, &["config", k, v]);
        }
        commit(p, "a.txt", "one\ntwo\n");
        commit(p, "same.txt", "same\n");
        commit(p, "gone.txt", "gone\n");
        git(p, &["branch", "base"]);
        commit(p, "a.txt", "one\ntwo\nthree\nfour\n");
        commit(p, "new.txt", "new\n");
        git(p, &["rm", "-q", "gone.txt"]);
        git(p, &["commit", "-q", "-m", "rm gone.txt"]);
        dir
    }

    fn task(repo: &Path) -> Task {
        Task { id: "t1".into(), path: repo.to_string_lossy().into_owned(), ..Default::default() }
    }

    fn new_review(task: &Task) -> Review {
        create(task, NewReview {
            range: "base..main".into(),
            title: Some(" Login fix ".into()),
            author: "claude".into(),
            recipient_tab: Some("tab1".into()),
            dir_name: String::new(),
        })
        .unwrap()
    }

    fn agent_comment(file: &str, lines: Option<(u32, u32)>, body: &str) -> ReviewOp {
        ReviewOp::Comment { file: file.into(), lines, body: body.into(), by: ReviewBy::Agent, author: "claude".into(), quote: None, round: None }
    }

    fn user_reply(thread: &str, body: &str) -> ReviewOp {
        ReviewOp::Reply { thread_id: thread.into(), body: body.into(), by: ReviewBy::User, author: String::new() }
    }

    fn rev_parse(repo: &Path, rev: &str) -> String {
        crate::git(&["rev-parse", rev], repo).unwrap().trim().to_string()
    }

    #[test]
    fn create_resolves_both_refs_to_full_shas_and_lists_only_the_files_changed_in_the_range() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let r = new_review(&t);

            assert_eq!(r.id, "r1");
            assert_eq!(r.base, rev_parse(dir.path(), "base"));
            assert_eq!(r.head, rev_parse(dir.path(), "main"));
            assert_eq!((r.base_ref.as_str(), r.head_ref.as_str()), ("base", "main"));
            assert_eq!(r.files, vec!["a.txt", "gone.txt", "new.txt"]);
            assert!(!r.files_truncated);
            assert_eq!(r.title.as_deref(), Some("Login fix"));
            assert_eq!(r.recipient_tab.as_deref(), Some("tab1"));
            assert_eq!((r.seq, r.threads.len()), (0, 0));
            assert_eq!(load(&t, "r1").unwrap(), r, "persisted as returned");
        });
    }

    #[test]
    fn create_numbers_reviews_r1_then_r2() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let first = new_review(&t);
            let second = new_review(&t);

            assert_eq!((first.id.as_str(), second.id.as_str()), ("r1", "r2"));
        });
    }

    fn create_range(task: &Task, range: &str) -> Result<Review, ReviewError> {
        create(task, NewReview {
            range: range.into(),
            title: None,
            author: "claude".into(),
            recipient_tab: None,
            dir_name: String::new(),
        })
    }

    #[test]
    fn create_accepts_relative_revs_and_stores_the_shas_they_resolve_to() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let r = create_range(&t, "HEAD~2..main^").unwrap();

            assert_eq!(r.base, rev_parse(dir.path(), "HEAD~2"));
            assert_eq!(r.head, rev_parse(dir.path(), "HEAD~1"));
            assert_eq!((r.base_ref.as_str(), r.head_ref.as_str()), ("HEAD~2", "main^"));
            assert_eq!(r.files, vec!["new.txt"]);
        });
    }

    #[test]
    fn create_diffs_from_the_merge_base_so_commits_the_base_gained_after_branching_are_not_listed() {
        let dir = repo();
        let p = dir.path();
        git(p, &["checkout", "-q", "-b", "feature", "base"]);
        commit(p, "feature.txt", "feature\n");
        let t = task(p);
        with_scratch_data_dir(|_| {
            let r = create_range(&t, "main..feature").unwrap();

            assert_eq!(r.base, rev_parse(p, "base"), "the merge-base, not main's tip");
            assert_eq!(r.head, rev_parse(p, "feature"));
            assert_eq!((r.base_ref.as_str(), r.head_ref.as_str()), ("main", "feature"));
            assert_eq!(r.files, vec!["feature.txt"]);
        });
    }

    #[test]
    fn create_diffs_from_the_base_tip_when_the_two_histories_share_no_commit() {
        let dir = repo();
        let p = dir.path();
        git(p, &["checkout", "-q", "--orphan", "other"]);
        git(p, &["rm", "-rqf", "."]);
        commit(p, "other.txt", "other\n");
        let t = task(p);
        with_scratch_data_dir(|_| {
            let r = create_range(&t, "main..other").unwrap();

            assert_eq!(r.base, rev_parse(p, "main"));
            assert_eq!(r.head, rev_parse(p, "other"));
        });
    }

    #[test]
    fn create_refuses_an_unknown_or_option_shaped_rev_as_invalid_input() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let unknown = create_range(&t, "base..nope");
            let option = create_range(&t, "--all..main");

            assert_eq!(unknown.unwrap_err(), ReviewError::Invalid("nope isn't a commit in this repo".into()));
            assert_eq!(option.unwrap_err(), ReviewError::Invalid("--all isn't a commit in this repo".into()));
            assert!(!data.join("scratch/t1/reviews").exists());
        });
    }

    #[test]
    fn create_refuses_a_range_with_no_changes() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let r = create_range(&t, "main..main");

            assert_eq!(r.unwrap_err(), ReviewError::Invalid("nothing changed in main..main".into()));
            assert!(!data.join("scratch/t1/reviews").exists());
        });
    }

    #[test]
    fn comment_with_lines_quotes_those_lines_of_the_head_side_and_takes_the_next_seq() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let (r, posted, changed) = apply(&t, "r1", vec![agent_comment("a.txt", Some((2, 3)), "why three?")]).unwrap();

            assert!(changed);
            assert_eq!(posted, vec![Posted { thread_id: "r1-t1".into(), seq: 1, new_thread: true }]);
            let th = &r.threads[0];
            assert_eq!((th.file.as_str(), th.start_line, th.end_line), ("a.txt", Some(2), Some(3)));
            assert_eq!(th.quote, "two\nthree");
            assert_eq!((th.comments[0].by, th.comments[0].author.as_str()), (ReviewBy::Agent, "claude"));
            assert_eq!(r.seq, 1);
            assert_eq!(load(&t, "r1").unwrap(), r);
        });
    }

    #[test]
    fn comment_on_a_line_past_the_end_of_the_head_file_is_refused() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let r = apply(&t, "r1", vec![agent_comment("a.txt", Some((4, 5)), "x")]);

            assert!(matches!(r, Err(ReviewError::Invalid(ref m)) if m.contains("has 4 lines")), "{r:?}");
        });
    }

    #[test]
    fn comment_on_a_file_the_range_does_not_change_is_refused() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let r = apply(&t, "r1", vec![agent_comment("same.txt", None, "x")]);

            assert_eq!(r.unwrap_err(), ReviewError::Invalid("same.txt is not changed in base..main".into()));
        });
    }

    #[test]
    fn line_comment_on_a_file_deleted_at_head_is_refused_with_a_file_level_hint() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let r = apply(&t, "r1", vec![agent_comment("gone.txt", Some((1, 1)), "x")]);

            assert_eq!(r.unwrap_err(), ReviewError::Invalid("gone.txt is deleted at main; comment at file level".into()));
        });
    }

    #[test]
    fn user_comment_with_line_zero_or_a_backwards_range_is_refused_even_with_a_quote() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);
            let op = |lines| ReviewOp::Comment {
                file: "a.txt".into(),
                lines: Some(lines),
                body: "x".into(),
                by: ReviewBy::User,
                author: String::new(),
                quote: Some("q".into()),
                round: None,
            };

            let zero = apply(&t, "r1", vec![op((0, 1))]);
            let backwards = apply(&t, "r1", vec![op((3, 2))]);

            assert_eq!(zero.unwrap_err(), ReviewError::Invalid("0-1 is not a line range".into()));
            assert_eq!(backwards.unwrap_err(), ReviewError::Invalid("3-2 is not a line range".into()));
        });
    }

    #[test]
    fn file_level_comment_has_no_lines_and_an_empty_quote() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let (r, _, _) = apply(&t, "r1", vec![agent_comment("new.txt", None, "generated?")]).unwrap();

            let th = &r.threads[0];
            assert_eq!((th.start_line, th.end_line, th.quote.as_str()), (None, None, ""));
        });
    }

    #[test]
    fn user_comment_keeps_the_quote_it_was_given_instead_of_reading_git() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);
            let op = ReviewOp::Comment {
                file: "a.txt".into(),
                lines: Some((1, 1)),
                body: "rename".into(),
                by: ReviewBy::User,
                author: String::new(),
                quote: Some("as shown".into()),
                round: None,
            };

            let (r, _, _) = apply(&t, "r1", vec![op]).unwrap();

            assert_eq!(r.threads[0].quote, "as shown");
            assert_eq!((r.threads[0].comments[0].by, r.threads[0].comments[0].author.as_str()), (ReviewBy::User, ""));
        });
    }

    #[test]
    fn reply_appends_to_its_thread_and_bumps_seq_across_the_review() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);
            apply(&t, "r1", vec![agent_comment("a.txt", Some((1, 1)), "a"), agent_comment("new.txt", None, "b")]).unwrap();

            let (r, posted, changed) = apply(&t, "r1", vec![user_reply("r1-t1", "  fine  ")]).unwrap();

            assert!(changed);
            assert_eq!(posted, vec![Posted { thread_id: "r1-t1".into(), seq: 3, new_thread: false }]);
            assert_eq!(r.seq, 3);
            let replies: Vec<(u64, &str)> = r.threads[0].comments.iter().map(|c| (c.seq, c.body.as_str())).collect();
            assert_eq!(replies, vec![(1, "a"), (3, "fine")]);
        });
    }

    #[test]
    fn reply_to_an_unknown_thread_is_no_such_thread() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);

            let r = apply(&t, "r1", vec![user_reply("r1-t9", "x")]);

            assert_eq!(r.unwrap_err(), ReviewError::NoSuchThread("r1-t9".into()));
        });
    }

    #[test]
    fn post_turns_items_into_user_replies_line_threads_and_file_threads_and_persists_them() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);
            apply(&t, "r1", vec![agent_comment("a.txt", Some((1, 1)), "a")]).unwrap();
            let item = |thread_id: Option<&str>, file: Option<&str>, start_line, end_line, quote: Option<&str>, body: &str| ReviewPostItem {
                thread_id: thread_id.map(Into::into),
                file: file.map(Into::into),
                start_line,
                end_line,
                quote: quote.map(Into::into),
                body: body.into(),
                round: None,
            };

            let res = post(&t, "r1", vec![
                item(Some("r1-t1"), None, None, None, None, "reply"),
                item(None, Some("a.txt"), Some(3), None, Some("three"), "single line"),
                item(None, Some("new.txt"), None, None, None, "whole file"),
            ])
            .unwrap();

            let posted: Vec<(&str, u64, bool)> = res.posted.iter().map(|p| (p.thread_id.as_str(), p.seq, p.new_thread)).collect();
            assert_eq!(posted, vec![("r1-t1", 2, false), ("r1-t2", 3, true), ("r1-t3", 4, true)]);
            let r = &res.review;
            assert_eq!((r.threads[0].comments[1].by, r.threads[0].comments[1].author.as_str()), (ReviewBy::User, ""));
            assert_eq!((r.threads[1].start_line, r.threads[1].end_line, r.threads[1].quote.as_str()), (Some(3), Some(3), "three"));
            assert_eq!((r.threads[2].start_line, r.threads[2].quote.as_str()), (None, ""));
            assert_eq!(load(&t, "r1").unwrap(), res.review);
        });
    }

    #[test]
    fn post_refuses_a_new_thread_without_a_file_or_with_end_line_but_no_start_line_and_writes_nothing() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            new_review(&t);
            let item = |file: Option<&str>, end_line| ReviewPostItem {
                thread_id: None,
                file: file.map(Into::into),
                start_line: None,
                end_line,
                quote: None,
                body: "x".into(),
                round: None,
            };
            let no_file = post(&t, "r1", vec![item(Some("new.txt"), None), item(None, None)]);
            let end_only = post(&t, "r1", vec![item(Some("a.txt"), Some(2))]);

            assert_eq!(no_file.err(), Some(ReviewError::Invalid("a new thread needs a file".into())));
            assert_eq!(end_only.err(), Some(ReviewError::Invalid("end_line without start_line".into())));
            assert!(load(&t, "r1").unwrap().threads.is_empty());
        });
    }

    #[test]
    fn apply_to_an_unknown_review_is_no_such_review() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let r = apply(&t, "r4", vec![user_reply("r4-t1", "x")]);

            assert_eq!(r.unwrap_err(), ReviewError::NoSuchReview("r4".into()));
        });
    }

    #[test]
    fn a_batch_with_one_invalid_op_writes_nothing() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let before = new_review(&t);

            let r = apply(&t, "r1", vec![agent_comment("a.txt", Some((1, 1)), "ok"), agent_comment("a.txt", None, "   ")]);

            assert!(matches!(r, Err(ReviewError::Invalid(ref m)) if m.contains("empty")), "{r:?}");
            assert_eq!(load(&t, "r1").unwrap(), before);
        });
    }

    #[test]
    fn a_thread_past_the_thread_cap_is_refused() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let mut full = new_review(&t);
            let thread = |i: usize| ReviewThread {
                id: format!("r1-t{i}"),
                file: "a.txt".into(),
                start_line: None,
                end_line: None,
                quote: String::new(),
                comments: Vec::new(),
                resolved: None,
                round: 1,
                origin: None,
                outdated: None,
            };
            full.threads = (1..=REVIEW_THREADS_MAX).map(thread).collect();
            write(&data.join("scratch/t1/reviews"), &full).unwrap();

            let r = apply(&t, "r1", vec![agent_comment("a.txt", None, "x")]);

            assert!(matches!(r, Err(ReviewError::Invalid(ref m)) if m.contains("threads")), "{r:?}");
        });
    }

    #[test]
    fn a_reply_past_the_per_thread_comment_cap_is_refused() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            new_review(&t);
            let (mut full, _, _) = apply(&t, "r1", vec![agent_comment("a.txt", None, "x")]).unwrap();
            let c = full.threads[0].comments[0].clone();
            full.threads[0].comments = vec![c; REVIEW_COMMENTS_PER_THREAD_MAX];
            write(&data.join("scratch/t1/reviews"), &full).unwrap();

            let r = apply(&t, "r1", vec![user_reply("r1-t1", "x")]);

            assert!(matches!(r, Err(ReviewError::Invalid(ref m)) if m.contains("comments")), "{r:?}");
        });
    }

    #[test]
    fn claim_points_the_review_at_the_new_tab_and_renames_its_author() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let before = new_review(&t);

            let (r, posted, changed) =
                apply(&t, "r1", vec![ReviewOp::Claim { tab: "tab2".into(), author: Some(" codex ".into()) }]).unwrap();

            assert!(changed && posted.is_empty());
            assert_eq!((r.recipient_tab.as_deref(), r.author.as_str()), (Some("tab2"), "codex"));
            assert_eq!(r.seq, before.seq + 1, "a claim that moved something bumps seq");
            assert_eq!(load(&t, "r1").unwrap(), r);
        });
    }

    // The reviews dir is made read-only, so a write would fail: the unchanged
    // claim succeeding proves it never tried.
    #[cfg(unix)]
    #[test]
    fn claim_with_the_stored_tab_and_author_writes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            new_review(&t);
            let reviews = data.join("scratch/t1/reviews");
            fs::set_permissions(&reviews, fs::Permissions::from_mode(0o555)).unwrap();

            let same = apply(&t, "r1", vec![ReviewOp::Claim { tab: "tab1".into(), author: Some("claude".into()) }]);
            let other = apply(&t, "r1", vec![ReviewOp::Claim { tab: "tab2".into(), author: None }]);

            fs::set_permissions(&reviews, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(same.unwrap().2, false);
            assert!(matches!(other, Err(ReviewError::Io(_))), "the read-only guard is not doing anything");
        });
    }

    /// r1 with one agent thread, r1-t1, at seq 1.
    fn review_with_a_thread(t: &Task) {
        new_review(t);
        apply(t, "r1", vec![agent_comment("a.txt", Some((1, 1)), "why")]).unwrap();
    }

    #[test]
    fn agent_resolve_records_the_reviews_author_bumps_seq_once_and_writes() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);

            let (r, changed) = set_resolved(&t, "r1-t1", true, ReviewBy::Agent).unwrap();

            assert!(changed);
            assert_eq!(r.seq, 2);
            let res = r.threads[0].resolved.as_ref().unwrap();
            assert_eq!((res.by, res.author.as_str()), (ReviewBy::Agent, "claude"));
            assert!(!res.at.is_empty());
            assert_eq!(load(&t, "r1").unwrap(), r);
        });
    }

    #[test]
    fn user_resolve_records_an_empty_author() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);

            let (r, _) = set_resolved(&t, "r1-t1", true, ReviewBy::User).unwrap();

            let res = r.threads[0].resolved.as_ref().unwrap();
            assert_eq!((res.by, res.author.as_str()), (ReviewBy::User, ""));
        });
    }

    #[test]
    fn resolving_an_already_resolved_thread_reports_unchanged_and_keeps_seq_and_the_first_record() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);
            let (first, _) = set_resolved(&t, "r1-t1", true, ReviewBy::User).unwrap();

            let (r, changed) = set_resolved(&t, "r1-t1", true, ReviewBy::Agent).unwrap();

            assert!(!changed);
            assert_eq!(r, first);
        });
    }

    #[test]
    fn unresolve_clears_the_record_and_bumps_seq() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);
            set_resolved(&t, "r1-t1", true, ReviewBy::User).unwrap();

            let (r, changed) = set_resolved(&t, "r1-t1", false, ReviewBy::Agent).unwrap();

            assert!(changed);
            assert_eq!(r.seq, 3);
            assert_eq!(r.threads[0].resolved, None);
            assert_eq!(load(&t, "r1").unwrap(), r);
        });
    }

    #[test]
    fn unresolving_an_open_thread_reports_unchanged_and_keeps_seq() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);

            let (r, changed) = set_resolved(&t, "r1-t1", false, ReviewBy::User).unwrap();

            assert!(!changed);
            assert_eq!(r.seq, 1);
        });
    }

    #[test]
    fn a_reply_from_the_user_or_the_agent_reopens_a_resolved_thread() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);
            let agent_reply =
                ReviewOp::Reply { thread_id: "r1-t1".into(), body: "fixed".into(), by: ReviewBy::Agent, author: "claude".into() };

            set_resolved(&t, "r1-t1", true, ReviewBy::Agent).unwrap();
            let (after_user, _, _) = apply(&t, "r1", vec![user_reply("r1-t1", "not quite")]).unwrap();
            set_resolved(&t, "r1-t1", true, ReviewBy::User).unwrap();
            let (after_agent, _, _) = apply(&t, "r1", vec![agent_reply]).unwrap();

            assert_eq!(after_user.threads[0].resolved, None);
            assert_eq!(after_agent.threads[0].resolved, None);
        });
    }

    #[test]
    fn set_resolved_on_an_unknown_thread_is_no_such_thread() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            review_with_a_thread(&t);

            let r = set_resolved(&t, "r1-t9", true, ReviewBy::Agent);

            assert_eq!(r.unwrap_err(), ReviewError::NoSuchThread("r1-t9".into()));
        });
    }

    #[test]
    fn set_resolved_with_a_malformed_thread_id_is_invalid_before_touching_the_disk() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            let r = set_resolved(&t, "r1", true, ReviewBy::Agent);

            assert!(matches!(r, Err(ReviewError::Invalid(ref m)) if m.contains("not a thread id")), "{r:?}");
        });
    }

    #[test]
    fn a_stored_thread_with_no_resolved_key_loads_as_open() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            review_with_a_thread(&t);
            let path = data.join("scratch/t1/reviews/r1.json");
            let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            json["threads"][0].as_object_mut().unwrap().remove("resolved");
            fs::write(&path, json.to_string()).unwrap();

            let r = load(&t, "r1").unwrap();

            assert_eq!(r.threads[0].resolved, None);
        });
    }

    #[test]
    fn list_sorts_by_number_and_skips_a_corrupt_file() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let mut tenth = new_review(&t);
            new_review(&t);
            let reviews = data.join("scratch/t1/reviews");
            tenth.id = "r10".into();
            write(&reviews, &tenth).unwrap();
            fs::write(reviews.join("r2.json"), "{ torn").unwrap();
            fs::write(reviews.join("notes.txt"), "not a review").unwrap();

            let ids: Vec<String> = list(&t).into_iter().map(|r| r.id).collect();
            let next = new_review(&t);

            assert_eq!(ids, vec!["r1", "r10"], "numeric, not lexical, order");
            assert_eq!(next.id, "r11");
        });
    }

    #[test]
    fn a_file_holding_another_reviews_id_is_corrupt_and_never_overwrites_that_review() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let first = new_review(&t);
            let reviews = data.join("scratch/t1/reviews");
            fs::copy(reviews.join("r1.json"), reviews.join("r5.json")).unwrap();

            let loaded = load(&t, "r5");
            let applied = apply(&t, "r5", vec![agent_comment("a.txt", None, "x")]);

            assert!(matches!(loaded, Err(ReviewError::Io(ref m)) if m.contains("holds review r1")), "{loaded:?}");
            assert!(matches!(applied, Err(ReviewError::Io(_))), "{applied:?}");
            assert_eq!(load(&t, "r1").unwrap(), first);
        });
    }

    #[test]
    fn a_review_whose_round_head_is_flag_shaped_is_refused_before_git_sees_it() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            new_review(&t);
            let file = data.join("scratch/t1/reviews/r1.json");
            let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
            json["rounds"][0]["head"] = "--output=/tmp/x".into();
            fs::write(&file, json.to_string()).unwrap();

            let loaded = load(&t, "r1");
            let updated = update(&t, "r1", NewRound { head: "HEAD".into(), base: None, show: None });

            assert!(matches!(loaded, Err(ReviewError::Io(ref m)) if m.contains("must be commit shas")), "{loaded:?}");
            assert!(matches!(updated, Err(ReviewError::Io(_))), "{updated:?}");
        });
    }

    #[test]
    fn list_and_apply_never_scan_the_task_files() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|_| {
            for _ in 0..3 {
                new_review(&t);
            }
            let before = crate::task_dir_scans();

            let all = list(&t);
            apply(&t, "r2", vec![agent_comment("a.txt", Some((1, 2)), "x")]).unwrap();

            assert_eq!(all.len(), 3);
            assert_eq!(crate::task_dir_scans() - before, 0);
        });
    }

    #[test]
    fn reading_a_task_with_no_reviews_creates_no_folder() {
        let dir = repo();
        let t = task(dir.path());
        with_scratch_data_dir(|data| {
            let all = list(&t);
            let one = load(&t, "r1");

            assert!(all.is_empty());
            assert_eq!(one.unwrap_err(), ReviewError::NoSuchReview("r1".into()));
            assert!(!data.join("scratch/t1").exists());
        });
    }

    #[test]
    fn load_refuses_an_id_that_is_not_r_n_before_touching_the_disk() {
        with_scratch_data_dir(|_| {
            let r = load(&task(Path::new("/x")), "../../tasks/t1");

            assert!(matches!(r, Err(ReviewError::Invalid(_))), "{r:?}");
        });
    }

    /// `n` numbered lines, long enough for rename detection to pair an edited copy.
    fn numbered(n: usize, tag: &str) -> String {
        (1..=n).map(|i| format!("{tag} line {i} with enough text to be similar\n")).collect()
    }

    /// `base` holds keep.txt; `main` then adds code.txt (12 lines), ren.txt,
    /// ren2.txt and del.txt, and edits keep.txt. Review r1 is base..main with
    /// threads t1 code:10, t2 code:3-4, t3 del (file), t4 ren:2, t5 code:12
    /// (resolved), t6 keep (file), t7 ren2:1.
    fn rounds_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "Test"), ("user.email", "t@t"), ("core.autocrlf", "false")] {
            git(p, &["config", k, v]);
        }
        commit(p, "keep.txt", "k\n");
        git(p, &["branch", "base"]);
        for (name, content) in [
            ("code.txt", numbered(12, "code")),
            ("ren.txt", numbered(6, "ren")),
            ("ren2.txt", numbered(6, "ren2")),
            ("del.txt", "d\n".into()),
            ("keep.txt", "k2\n".into()),
        ] {
            fs::write(p.join(name), content).unwrap();
        }
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "round 1"]);
        let t = task(p);
        create(&t, NewReview { range: "base..main".into(), title: None, author: "claude".into(), recipient_tab: None, dir_name: String::new() })
            .unwrap();
        apply(&t, "r1", vec![
            agent_comment("code.txt", Some((10, 10)), "t1"),
            agent_comment("code.txt", Some((3, 4)), "t2"),
            agent_comment("del.txt", None, "t3"),
            agent_comment("ren.txt", Some((2, 2)), "t4"),
            agent_comment("code.txt", Some((12, 12)), "t5"),
            agent_comment("keep.txt", None, "t6"),
            agent_comment("ren2.txt", Some((1, 1)), "t7"),
        ])
        .unwrap();
        set_resolved(&t, "r1-t5", true, ReviewBy::User).unwrap();
        dir
    }

    /// Two lines in at the top of code.txt and its old line 4 changed;
    /// del.txt deleted; ren.txt renamed as is; ren2.txt renamed with its last
    /// line edited; keep.txt back to its base content.
    fn round_two_commit(p: &Path) {
        let mut code: Vec<String> = numbered(12, "code").lines().map(str::to_string).collect();
        code[3] = "changed".into();
        code.splice(0..0, ["new 1".to_string(), "new 2".to_string()]);
        fs::write(p.join("code.txt"), code.join("\n") + "\n").unwrap();
        fs::write(p.join("ren2.txt"), numbered(6, "ren2").replace("ren2 line 6", "ren2 line six")).unwrap();
        fs::write(p.join("keep.txt"), "k\n").unwrap();
        git(p, &["rm", "-q", "del.txt"]);
        git(p, &["mv", "ren.txt", "moved.txt"]);
        git(p, &["mv", "ren2.txt", "moved2.txt"]);
        git(p, &["commit", "-qam", "round 2"]);
    }

    fn head_update() -> NewRound {
        NewRound { head: "HEAD".into(), base: None, show: None }
    }

    fn anchor(th: &ReviewThread) -> (&str, Option<u32>, Option<u32>) {
        (th.file.as_str(), th.start_line, th.end_line)
    }

    #[test]
    fn update_moves_shifted_and_renamed_threads_and_outdates_changed_deleted_and_out_of_range_ones() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let t = task(dir.path());
            round_two_commit(dir.path());

            let (r, outdated) = update(&t, "r1", head_update()).unwrap();

            let th = |i: usize| &r.threads[i - 1];
            assert_eq!(anchor(th(1)), ("code.txt", Some(12), Some(12)), "shifted by the two lines on top");
            assert_eq!(th(1).origin_anchor(), termic_proto::ReviewAnchor { file: "code.txt".into(), start_line: Some(10), end_line: Some(10) });
            assert_eq!(anchor(th(4)), ("moved.txt", Some(2), Some(2)), "a pure rename follows");
            assert_eq!(anchor(th(7)), ("moved2.txt", Some(1), Some(1)), "an edited rename follows");
            assert_eq!(anchor(th(5)), ("code.txt", Some(14), Some(14)));
            assert!(th(5).resolved.is_some(), "re-anchoring never touches resolved");
            for i in [1, 4, 5, 7] {
                assert_eq!(th(i).outdated, None, "t{i}");
            }
            for i in [2, 3, 6] {
                assert_eq!(th(i).outdated, Some(2), "t{i}");
                assert_eq!(th(i).origin, None, "an outdated thread keeps its last live anchor as is");
            }
            assert_eq!(anchor(th(2)), ("code.txt", Some(3), Some(4)));
            let ids: Vec<&str> = outdated.iter().map(|o| o.thread_id.as_str()).collect();
            assert_eq!(ids, vec!["r1-t2", "r1-t3", "r1-t6"]);
            assert_eq!(outdated[0], ReviewOutdated { thread_id: "r1-t2".into(), file: "code.txt".into(), start_line: Some(3), end_line: Some(4), round: 1 });
            assert_eq!(load(&t, "r1").unwrap(), r);
        });
    }

    #[test]
    fn update_appends_the_round_and_mirrors_it_at_the_top_level() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);
            let before = load(&t, "r1").unwrap();
            round_two_commit(p);

            let (r, _) = update(&t, "r1", NewRound { head: "HEAD".into(), base: None, show: Some(Some(1)) }).unwrap();

            assert_eq!(r.rounds.len(), 2);
            assert_eq!(r.rounds[0], before.rounds[0]);
            let r2 = &r.rounds[1];
            assert_eq!((r2.base.as_str(), r2.head.as_str()), (rev_parse(p, "base").as_str(), rev_parse(p, "HEAD").as_str()));
            assert_eq!((r2.base_ref.as_str(), r2.head_ref.as_str()), ("base", "HEAD"));
            assert_eq!((&r.base, &r.head, &r.base_ref, &r.head_ref), (&r2.base, &r2.head, &r2.base_ref, &r2.head_ref));
            assert_eq!(r.files, vec!["code.txt", "moved.txt", "moved2.txt"]);
            assert_eq!(r.default_from, Some(1));
            assert_eq!(r.seq, before.seq + 1);
        });
    }

    #[test]
    fn an_outdated_thread_stays_outdated_in_its_round_and_is_not_reported_again() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);
            round_two_commit(p);
            update(&t, "r1", head_update()).unwrap();
            commit(p, "code.txt", "rewritten\n");

            let (r, outdated) = update(&t, "r1", head_update()).unwrap();

            assert_eq!(r.threads[1].outdated, Some(2));
            assert_eq!(r.threads[0].outdated, Some(3));
            assert!(!outdated.iter().any(|o| o.thread_id == "r1-t2"));
        });
    }

    #[test]
    fn a_thread_moved_in_one_round_and_outdated_in_the_next_is_reported_where_it_was_opened() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);
            round_two_commit(p);
            update(&t, "r1", head_update()).unwrap();
            commit(p, "code.txt", "rewritten\n");

            let (_, outdated) = update(&t, "r1", head_update()).unwrap();

            let t1 = outdated.iter().find(|o| o.thread_id == "r1-t1").unwrap();
            assert_eq!((t1.file.as_str(), t1.start_line, t1.end_line, t1.round), ("code.txt", Some(10), Some(10), 1));
        });
    }

    #[test]
    fn update_refuses_when_another_round_landed_between_its_snapshot_and_the_lock() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);
            round_two_commit(p);
            let slow = prepare_update(&t, "r1", head_update()).unwrap();
            update(&t, "r1", head_update()).unwrap();

            let late = finish_update(&t, "r1", slow);

            assert_eq!(late.unwrap_err(), ReviewError::Invalid("review r1 moved to round 2 meanwhile; update it again".into()));
            assert_eq!(load(&t, "r1").unwrap().rounds.len(), 2);
        });
    }

    #[test]
    fn a_comment_after_an_update_is_stamped_with_the_new_round() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let t = task(dir.path());
            round_two_commit(dir.path());
            update(&t, "r1", head_update()).unwrap();

            let (r, _, _) = apply(&t, "r1", vec![agent_comment("code.txt", Some((1, 1)), "new"), user_reply("r1-t1", "ok")]).unwrap();

            let new = r.threads.last().unwrap();
            assert_eq!((new.round, new.comments[0].round), (2, 2));
            assert_eq!((r.threads[0].round, r.threads[0].comments[0].round, r.threads[0].comments[1].round), (1, 1, 2));
        });
    }

    #[test]
    fn update_refuses_the_same_range_a_show_not_before_the_new_round_and_an_empty_range() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);

            let same = update(&t, "r1", head_update());
            round_two_commit(p);
            let late_show = update(&t, "r1", NewRound { head: "HEAD".into(), base: None, show: Some(Some(2)) });
            let empty = update(&t, "r1", NewRound { head: "HEAD".into(), base: Some("HEAD".into()), show: None });

            assert_eq!(same.unwrap_err(), ReviewError::Invalid("round 1 of r1 is already base..main".into()));
            assert_eq!(late_show.unwrap_err(), ReviewError::Invalid("round 2 is not before round 2".into()));
            assert_eq!(empty.unwrap_err(), ReviewError::Invalid("nothing changed in HEAD..HEAD".into()));
            assert_eq!(load(&t, "r1").unwrap().rounds.len(), 1);
        });
    }

    #[test]
    fn update_without_a_base_resolves_the_last_base_ref_again_so_a_rebase_takes_the_new_merge_base() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let p = dir.path();
            let t = task(p);
            git(p, &["checkout", "-q", "base"]);
            commit(p, "upstream.txt", "u\n");
            git(p, &["checkout", "-q", "main"]);
            git(p, &["rebase", "-q", "base"]);

            let (r, _) = update(&t, "r1", head_update()).unwrap();

            assert_eq!(r.base, rev_parse(p, "base"), "the moved base, not round 1's");
            assert!(!r.files.contains(&"upstream.txt".to_string()));
        });
    }

    fn ref_sha(repo: &Path, name: &str) -> Option<String> {
        crate::git(&["rev-parse", "--verify", "--quiet", name], repo).ok().map(|s| s.trim().to_string())
    }

    #[test]
    fn create_and_update_pin_each_rounds_commits_so_an_amended_away_head_survives_gc() {
        let dir = repo();
        let p = dir.path();
        let t = task(p);
        with_scratch_data_dir(|_| {
            let r = new_review(&t);
            fs::write(p.join("new.txt"), "amended\n").unwrap();
            git(p, &["commit", "-q", "-a", "--amend", "-m", "amended"]);
            update(&t, "r1", head_update()).unwrap();
            git(p, &["reflog", "expire", "--expire=now", "--all"]);
            git(p, &["gc", "-q", "--prune=now"]);

            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/1/head"), Some(r.head.clone()));
            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/1/base"), Some(r.base.clone()));
            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/2/head"), Some(rev_parse(p, "HEAD")));
            assert!(crate::git(&["cat-file", "-e", &format!("{}^{{commit}}", r.head)], p).is_ok());
        });
    }

    #[test]
    fn a_review_written_before_rounds_loads_as_one_round_and_its_first_update_pins_round_one() {
        let dir = repo();
        let p = dir.path();
        let t = task(p);
        with_scratch_data_dir(|data| {
            let r = new_review(&t);
            git(p, &["update-ref", "-d", "refs/termic/reviews/t1/r1/1/head"]);
            git(p, &["update-ref", "-d", "refs/termic/reviews/t1/r1/1/base"]);
            let path = data.join("scratch/t1/reviews/r1.json");
            let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            json.as_object_mut().unwrap().remove("rounds");
            fs::write(&path, json.to_string()).unwrap();

            let legacy = load(&t, "r1").unwrap();
            commit(p, "new.txt", "round 2\n");
            update(&t, "r1", head_update()).unwrap();

            assert_eq!(legacy.rounds, r.rounds);
            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/1/head"), Some(r.head));
        });
    }

    #[test]
    fn a_user_comment_written_on_an_older_round_is_refused_and_an_unstamped_one_or_a_reply_is_not() {
        with_scratch_data_dir(|_| {
            let dir = rounds_repo();
            let t = task(dir.path());
            round_two_commit(dir.path());
            update(&t, "r1", head_update()).unwrap();
            let item = |thread_id: Option<&str>, round| ReviewPostItem {
                thread_id: thread_id.map(Into::into),
                file: Some("code.txt".into()),
                start_line: Some(1),
                end_line: None,
                quote: Some("new 1".into()),
                body: "x".into(),
                round,
            };

            let stale = post(&t, "r1", vec![item(None, Some(1))]);
            let current = post(&t, "r1", vec![item(None, Some(2))]);
            let unstamped = post(&t, "r1", vec![item(None, None)]);
            let reply = post(&t, "r1", vec![item(Some("r1-t2"), Some(1))]);

            assert_eq!(
                stale.err(),
                Some(ReviewError::Invalid("this comment was written on round 1 of r1, which is now on round 2; comment on the new diff".into()))
            );
            assert!(current.is_ok());
            assert_eq!(unstamped.unwrap().review.threads.last().unwrap().round, 2, "no round is the latest");
            assert!(reply.is_ok());
        });
    }

    #[test]
    fn drop_task_refs_deletes_only_that_tasks_review_refs() {
        let dir = repo();
        let p = dir.path();
        let t1 = task(p);
        let t2 = Task { id: "t2".into(), ..task(p) };
        with_scratch_data_dir(|_| {
            new_review(&t1);
            new_review(&t2);

            crate::review_rounds::drop_task_refs("t1", &[p.to_path_buf()]);

            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/1/head"), None);
            assert!(ref_sha(p, "refs/termic/reviews/t2/r1/1/head").is_some());
        });
    }

    #[test]
    fn deleting_a_task_for_good_removes_its_reviews_and_their_round_refs() {
        let dir = repo();
        let p = dir.path();
        let t = Task { project_id: "p1".into(), ..task(p) };
        let project = crate::Project { id: "p1".into(), root_path: p.to_string_lossy().into_owned(), ..Default::default() };
        with_scratch_data_dir(|data| {
            new_review(&t);
            assert!(data.join("scratch/t1/reviews/r1.json").is_file());
            assert!(ref_sha(p, "refs/termic/reviews/t1/r1/1/head").is_some());

            crate::delete_task_for_good(&t, &[project]).unwrap();

            assert!(!data.join("scratch/t1").exists());
            assert!(list(&t).is_empty());
            assert_eq!(ref_sha(p, "refs/termic/reviews/t1/r1/1/head"), None);
        });
    }

    #[test]
    fn task_delete_and_project_remove_both_delete_through_the_helper_that_drops_refs() {
        let src = include_str!("lib.rs");
        for f in ["async fn task_delete(", "async fn project_remove("] {
            let body = src.split_once(f).expect("command exists").1;
            let body = &body[..body.find("\n}\n").expect("function ends")];
            assert!(body.contains("delete_task_for_good("), "{f} skips the review refs");
        }
    }
}
