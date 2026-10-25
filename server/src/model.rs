//! A wayfinder map kept as GitHub issues, turned into the graph the star-map draws.
//!
//! The map is one issue; its sub-issues are the tickets. A ticket's status is derived, never
//! stored: closed as completed is resolved, closed as not planned is out of scope, an open ticket
//! whose assignee has commented on it is claimed, and any other open ticket is on the frontier
//! when every blocker is closed (blockers outside the map count too) and blocked otherwise. An
//! assignee who never commented left an abandoned claim: the ticket is free, flagged `staleClaim`.
//!
//! The build hangs off the map too. A ticket's own sub-issues are its build slices (a fold-in's,
//! usually), and a ticket on the map that carries a build label (`ready-for-agent`,
//! `ready-for-human`, `size:*`) instead of a `wayfinder:` type is a slice with no parent. A
//! slice's state is derived the same way: closed is built (dropped when not planned), and an
//! open one needs a human, is blocked, is being built (claimed, or a PR names it) or is ready.
//! The agent and owner checks on a slice are the `check:` issues written from it ("From slice
//! #613 …").
//!
//! A map carries only what its overview needs: how many slices each ticket has and how many are
//! closed, and the slices on the map itself. A ticket's slices are read when it's opened
//! (`slices_of`), because GitHub limits how often sub-issues and dependencies can be read.

use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Debug, Clone, Default)]
pub struct RawIssue {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub url: String,
    pub open: bool,
    /// Closed as not planned (or as a duplicate): a scope boundary, not a decision.
    pub not_planned: bool,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub blocked_by: Vec<RawRef>,
    pub comments: Vec<RawComment>,
    /// When it last changed, and when it was closed (ISO 8601).
    pub updated_at: String,
    pub closed_at: Option<String>,
    /// How many sub-issues (build slices) it has, and how many of them are closed.
    pub sub_total: u32,
    pub sub_closed: u32,
    /// PRs that reference this one.
    pub xrefs: Vec<RawPr>,
}

#[derive(Debug, Clone, Default)]
pub struct RawPr {
    pub number: u32,
    pub url: String,
    pub open: bool,
    pub merged: bool,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct RawRef {
    pub number: u32,
    pub title: String,
    pub open: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RawComment {
    pub author: String,
    pub body: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Resolved,
    OutOfScope,
    Claimed,
    Frontier,
    Blocked,
}

impl Status {
    pub fn is_open(self) -> bool {
        matches!(self, Status::Claimed | Status::Frontier | Status::Blocked)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub num: u32,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: Status,
    pub url: String,
    pub body: String,
    /// The comments of a closed ticket, its Answer (or its Ruled out).
    pub answer: Option<String>,
    /// The ticket's one-line gist in the map's Decisions so far.
    pub gist: Option<String>,
    pub assignee: Option<String>,
    pub stale_claim: bool,
    /// Blockers on this map.
    pub blockers: Vec<u32>,
    /// Blockers that aren't tickets on this map (a slice, another map's ticket).
    pub outside_blockers: Vec<OutsideBlocker>,
    pub rank: u32,
    /// Its build slices, counted; `slices_of` reads them.
    pub slices: Option<SliceCount>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct SliceCount {
    pub total: u32,
    /// Closed, as built or dropped.
    pub closed: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OutsideBlocker {
    pub num: u32,
    pub title: String,
    pub open: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Edge {
    pub from: u32,
    pub to: u32,
    pub satisfied: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fog {
    pub title: String,
    pub text: String,
    pub clears_with: Option<u32>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub total: usize,
    pub resolved: usize,
    pub out_of_scope: usize,
    pub claimed: usize,
    pub frontier: usize,
    pub blocked: usize,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SliceState {
    Ready,
    Blocked,
    Building,
    /// Labelled `ready-for-human`: a person has to do it, or do something first.
    Human,
    Built,
    Dropped,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PrRef {
    pub num: u32,
    pub url: String,
    pub merged: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub num: u32,
    pub title: String,
    pub url: String,
    /// `owner` or `agent`.
    pub kind: String,
    pub open: bool,
    /// The check's `**Due:**` line, as written: a date, or a condition like "when #829 is done".
    pub due: Option<String>,
    /// The slice it was written from.
    pub slice: Option<u32>,
    /// That slice's parent: a map ticket, or the map itself.
    pub parent: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub num: u32,
    pub title: String,
    pub url: String,
    pub body: String,
    /// The map ticket it's a sub-issue of; none for a slice that sits on the map itself.
    pub parent: Option<u32>,
    pub state: SliceState,
    /// From `size:xs` … `size:l`.
    pub size: Option<String>,
    pub escalate: bool,
    pub assignee: Option<String>,
    pub blockers: Vec<OutsideBlocker>,
    /// The PR building it: an open one naming it, or for a built slice the merged one.
    pub pr: Option<PrRef>,
    /// A merged PR already names this open slice: it may have shipped, so check before building.
    pub shipped: Option<PrRef>,
    pub checks: Vec<Check>,
    /// When anything last happened on it: the issue, or the open PR building it (ISO 8601).
    pub active: String,
    pub closed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Map {
    pub num: u32,
    pub name: String,
    pub url: String,
    pub open: bool,
    pub destination: String,
    pub notes: String,
    pub fog: Vec<Fog>,
    pub tickets: Vec<Ticket>,
    pub edges: Vec<Edge>,
    pub counts: Counts,
    /// The slices on the map itself; a ticket's are read on their own.
    pub slices: Vec<Slice>,
    /// The open checks written from this map's slices, its tickets' included.
    pub checks: Vec<Check>,
}

impl Map {
    pub fn ticket(&self, num: u32) -> Option<&Ticket> {
        self.tickets.iter().find(|t| t.num == num)
    }
    pub fn slice(&self, num: u32) -> Option<&Slice> {
        self.slices.iter().find(|s| s.num == num)
    }
}

/// A ticket on the map that's a build slice rather than a decision.
pub fn is_build(labels: &[String]) -> bool {
    labels
        .iter()
        .any(|l| l == "ready-for-agent" || l == "ready-for-human" || l.starts_with("size:"))
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());
static OWN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:Slice|Part of|part of|Builds|Closes|Fixes|Resolves|Implements) #(\d+)").unwrap());
static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(\d+)").unwrap());

/// A PR names an issue as its own, the rule `scripts/frontier.sh` uses: "Slice #n", "Part of
/// #n", "Closes #n" and the like, or #n as the first number on the body's first line. Fenced code
/// and passing mentions don't count: a PR that says "unblocks #769" didn't build #769.
pub fn names_as_own(body: &str, n: u32) -> bool {
    let b = FENCE.replace_all(body, "");
    let n = n.to_string();
    OWN.captures_iter(&b).any(|c| c[1] == n)
        || b.lines()
            .find(|l| !l.trim().is_empty())
            .and_then(|l| NUM.captures(l))
            .is_some_and(|c| c[1] == n)
}

static DUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*\*\*Due:?\*\*:?\s*(.+?)\s*$").unwrap());
// "From slice #613", or "**Slice:** [its title](https://github.com/o/r/issues/377)".
static FROM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bslice\b[^\n#]*?(?:#|/issues/)(\d+)").unwrap());
// An issue reference, not a colour like `#111114`: after a space or bracket, before a non-word.
static REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s(\[])#(\d{1,5})\b").unwrap());

/// A check issue: its kind from its `check:` label, the slice it was written from (named after
/// "slice", else the first issue it names) and its due line. None when it isn't a check.
pub fn check(number: u32, title: &str, url: &str, open: bool, labels: &[String], body: &str) -> Option<Check> {
    let kind = labels.iter().find_map(|l| l.strip_prefix("check:"))?;
    let b = FENCE.replace_all(body, "");
    Some(Check {
        num: number,
        title: title.to_string(),
        url: url.to_string(),
        kind: kind.to_string(),
        open,
        due: DUE.captures(body).map(|c| c[1].to_string()),
        slice: FROM
            .captures(&b)
            .or_else(|| REF.captures(&b))
            .and_then(|c| c[1].parse().ok()),
        parent: None,
    })
}

fn slice(t: &RawIssue, parent: Option<u32>, checks: &[Check]) -> Slice {
    let commented = t.comments.iter().any(|c| t.assignees.contains(&c.author));
    let own: Vec<&RawPr> = t.xrefs.iter().filter(|p| names_as_own(&p.body, t.number)).collect();
    let active = own
        .iter()
        .filter(|p| p.open)
        .map(|p| &p.updated_at)
        .chain([&t.updated_at])
        .max()
        .cloned()
        .unwrap_or_default();
    let prs: Vec<(u32, &String, bool, bool)> = own.iter().map(|p| (p.number, &p.url, p.open, p.merged)).collect();
    let pr_ref = |p: &(u32, &String, bool, bool)| PrRef {
        num: p.0,
        url: p.1.clone(),
        merged: p.3,
    };
    let open_pr = prs.iter().filter(|p| p.2).max_by_key(|p| p.0).map(pr_ref);
    let merged_pr = prs.iter().filter(|p| p.3).max_by_key(|p| p.0).map(pr_ref);
    let state = if !t.open {
        if t.not_planned {
            SliceState::Dropped
        } else {
            SliceState::Built
        }
    } else if t.labels.iter().any(|l| l == "ready-for-human") {
        SliceState::Human
    } else if t.blocked_by.iter().any(|b| b.open) {
        SliceState::Blocked
    } else if open_pr.is_some() || (!t.assignees.is_empty() && commented) {
        SliceState::Building
    } else {
        SliceState::Ready
    };
    let checks = checks.iter().filter(|c| c.slice == Some(t.number)).cloned().collect();
    Slice {
        num: t.number,
        title: t.title.clone(),
        url: t.url.clone(),
        body: t.body.clone(),
        parent,
        size: t
            .labels
            .iter()
            .find_map(|l| l.strip_prefix("size:"))
            .map(str::to_string),
        escalate: t.labels.iter().any(|l| l == "escalate"),
        assignee: t.assignees.first().cloned(),
        blockers: t
            .blocked_by
            .iter()
            .map(|b| OutsideBlocker {
                num: b.number,
                title: b.title.clone(),
                open: b.open,
            })
            .collect(),
        pr: if t.open { open_pr } else { merged_pr.clone() },
        shipped: if t.open { merged_pr } else { None },
        checks,
        state,
        active,
        closed_at: t.closed_at.clone(),
    }
}

const TYPES: [&str; 4] = ["research", "prototype", "grilling", "task"];

/// A ticket's build slices, from its sub-issues.
pub fn slices_of(parent: u32, subs: &[RawIssue], checks: &[Check]) -> Vec<Slice> {
    let mut out: Vec<Slice> = subs.iter().map(|t| slice(t, Some(parent), checks)).collect();
    out.sort_by_key(|s| s.num);
    out
}

/// `checks` are the repo's check issues, each with its slice's parent filled in.
pub fn build(map: RawIssue, mut subs: Vec<RawIssue>, checks: &[Check]) -> Map {
    subs.sort_by_key(|t| t.number);
    // Build slices on the map itself aren't decisions: they go with the slices.
    let (direct, subs): (Vec<RawIssue>, Vec<RawIssue>) = subs.into_iter().partition(|t| is_build(&t.labels));
    let slices: Vec<Slice> = direct.iter().map(|t| slice(t, None, checks)).collect();
    let on_map: HashSet<u32> = subs.iter().map(|t| t.number).collect();
    let map_checks = checks
        .iter()
        .filter(|c| c.open && c.parent.is_some_and(|p| p == map.number || on_map.contains(&p)))
        .cloned()
        .collect();
    let sections = sections(&map.body);
    let gists = gists(sections.get("decisions so far").map(String::as_str).unwrap_or(""));
    let fog = sections
        .iter()
        .find(|(k, _)| k.starts_with("not yet specified"))
        .map(|(_, v)| fog(v))
        .unwrap_or_default();

    let ranks = ranks(&subs, &on_map);
    let mut tickets: Vec<Ticket> = subs
        .iter()
        .map(|t| {
            let assignee = t.assignees.first().cloned();
            let commented = t.comments.iter().any(|c| t.assignees.contains(&c.author));
            let all_blockers_closed = t.blocked_by.iter().all(|b| !b.open);
            let status = if !t.open {
                if t.not_planned {
                    Status::OutOfScope
                } else {
                    Status::Resolved
                }
            } else if assignee.is_some() && commented {
                Status::Claimed
            } else if all_blockers_closed {
                Status::Frontier
            } else {
                Status::Blocked
            };
            let answer = (!t.open).then(|| {
                let joined = t
                    .comments
                    .iter()
                    .map(|c| c.body.trim())
                    .collect::<Vec<_>>()
                    .join("\n\n---\n\n");
                if joined.is_empty() {
                    "_Closed with no answer comment._".to_string()
                } else {
                    joined
                }
            });
            let kind = t
                .labels
                .iter()
                .filter_map(|l| l.strip_prefix("wayfinder:"))
                .find(|k| TYPES.contains(k))
                .unwrap_or("grilling")
                .to_string();
            Ticket {
                num: t.number,
                title: t.title.clone(),
                kind,
                status,
                url: t.url.clone(),
                body: t.body.clone(),
                answer,
                gist: gists.get(&t.number).cloned(),
                stale_claim: t.open && assignee.is_some() && !commented,
                assignee,
                blockers: t
                    .blocked_by
                    .iter()
                    .map(|b| b.number)
                    .filter(|n| on_map.contains(n))
                    .collect(),
                outside_blockers: t
                    .blocked_by
                    .iter()
                    .filter(|b| !on_map.contains(&b.number))
                    .map(|b| OutsideBlocker {
                        num: b.number,
                        title: b.title.clone(),
                        open: b.open,
                    })
                    .collect(),
                rank: ranks[&t.number],
                slices: (t.sub_total > 0).then_some(SliceCount {
                    total: t.sub_total,
                    closed: t.sub_closed,
                }),
            }
        })
        .collect();
    tickets.sort_by_key(|t| t.num);

    let open: HashMap<u32, bool> = subs.iter().map(|t| (t.number, t.open)).collect();
    let edges = tickets
        .iter()
        .flat_map(|t| {
            t.blockers.iter().map(|b| Edge {
                from: *b,
                to: t.num,
                satisfied: !open[b],
            })
        })
        .collect();

    let mut counts = Counts {
        total: tickets.len(),
        ..Counts::default()
    };
    for t in &tickets {
        match t.status {
            Status::Resolved => counts.resolved += 1,
            Status::OutOfScope => counts.out_of_scope += 1,
            Status::Claimed => counts.claimed += 1,
            Status::Frontier => counts.frontier += 1,
            Status::Blocked => counts.blocked += 1,
        }
    }

    Map {
        num: map.number,
        name: map.title,
        url: map.url,
        open: map.open,
        destination: sections
            .get("destination")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        notes: sections.get("notes").map(|s| s.trim().to_string()).unwrap_or_default(),
        fog,
        tickets,
        edges,
        counts,
        slices,
        checks: map_checks,
    }
}

/// A ticket's rank is one past its deepest blocker on the map, so the layout can pull roots
/// inward and deeper tickets to the rim. A blocked_by cycle contributes no depth.
fn ranks(subs: &[RawIssue], on_map: &HashSet<u32>) -> HashMap<u32, u32> {
    let by_num: HashMap<u32, &RawIssue> = subs.iter().map(|t| (t.number, t)).collect();
    fn depth(
        n: u32,
        by_num: &HashMap<u32, &RawIssue>,
        on_map: &HashSet<u32>,
        memo: &mut HashMap<u32, u32>,
        seen: &mut HashSet<u32>,
    ) -> u32 {
        if let Some(r) = memo.get(&n) {
            return *r;
        }
        if !seen.insert(n) {
            return 0;
        }
        let r = by_num[&n]
            .blocked_by
            .iter()
            .filter(|b| on_map.contains(&b.number))
            .map(|b| depth(b.number, by_num, on_map, memo, seen) + 1)
            .max()
            .unwrap_or(0);
        seen.remove(&n);
        memo.insert(n, r);
        r
    }
    let mut memo = HashMap::new();
    for t in subs {
        depth(t.number, &by_num, on_map, &mut memo, &mut HashSet::new());
    }
    memo
}

/// The map body's `## ` sections, keyed by lowercased heading. Headings inside a code fence
/// are text, not structure.
fn sections(body: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;
    let mut fenced = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        }
        if !fenced && let Some(h) = line.strip_prefix("## ") {
            let key = h.trim().to_lowercase();
            out.entry(key.clone()).or_default();
            current = Some(key);
            continue;
        }
        if let Some(k) = &current {
            let s = out.get_mut(k).expect("section was inserted");
            s.push_str(line);
            s.push('\n');
        }
    }
    out
}

static ISSUE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[[^\]]*\]\(https://github\.com/[^/\s]+/[^/\s]+/issues/(\d+)\)").unwrap());
static CLEARS_WITH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<clears-with:\s*#?(\d+)\s*>").unwrap());
static BOLD_LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\*\*(.+?)\*\*\s*(.*)$").unwrap());

/// Top-level bullets of a section, each with its indented continuation lines.
fn bullets(section: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in section.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        }
        if !fenced && let Some(b) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            out.push(b.trim().to_string());
        } else if let Some(last) = out.last_mut()
            && (line.starts_with(' ') || line.starts_with('\t'))
            && !t.is_empty()
        {
            last.push(' ');
            last.push_str(t);
        }
    }
    out
}

/// Decisions so far: each bullet's first issue link names the ticket; the text after it, past a
/// leading colon or dash, is the gist.
fn gists(section: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    for b in bullets(section) {
        let Some(m) = ISSUE_LINK.captures(&b) else { continue };
        let num: u32 = m[1].parse().unwrap_or(0);
        let rest = b[m.get(0).unwrap().end()..]
            .trim_start_matches([':', ' ', '—', '–', '-'])
            .trim();
        out.entry(num).or_insert_with(|| rest.to_string());
    }
    out
}

/// Fog patches: a bolded lead title, loose prose, and an optional `<clears-with: N>` anchor.
fn fog(section: &str) -> Vec<Fog> {
    bullets(section)
        .into_iter()
        .map(|b| {
            let clears_with = CLEARS_WITH.captures(&b).and_then(|m| m[1].parse().ok());
            let b = CLEARS_WITH.replace_all(&b, "").trim().to_string();
            match BOLD_LEAD.captures(&b) {
                Some(m) => Fog {
                    title: m[1].trim().trim_end_matches(['.', ':']).to_string(),
                    text: m[2].trim().to_string(),
                    clears_with,
                },
                None => {
                    let title: String = b.chars().take(48).collect();
                    let title = if b.chars().count() > 48 {
                        format!("{}…", title.trim_end())
                    } else {
                        title
                    };
                    Fog {
                        title,
                        text: b.clone(),
                        clears_with,
                    }
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(number: u32) -> RawIssue {
        RawIssue {
            number,
            title: format!("Ticket {number}"),
            url: format!("https://github.com/o/r/issues/{number}"),
            open: true,
            labels: vec!["wayfinder:research".into()],
            ..RawIssue::default()
        }
    }
    fn blocker(number: u32, open: bool) -> RawRef {
        RawRef {
            number,
            title: format!("Ticket {number}"),
            open,
        }
    }
    fn comment(author: &str) -> RawComment {
        RawComment {
            author: author.into(),
            body: "On it.".into(),
        }
    }
    fn map(body: &str) -> RawIssue {
        RawIssue {
            number: 1,
            title: "Wayfinder: A map".into(),
            body: body.into(),
            open: true,
            ..RawIssue::default()
        }
    }
    fn build_(map: RawIssue, subs: Vec<RawIssue>) -> Map {
        build(map, subs, &[])
    }
    fn status(m: &Map, n: u32) -> Status {
        m.ticket(n).unwrap().status
    }

    fn slice_issue(number: u32, labels: &[&str]) -> RawIssue {
        RawIssue {
            number,
            title: format!("Slice {number}"),
            url: format!("https://github.com/o/r/issues/{number}"),
            open: true,
            labels: labels.iter().map(|l| l.to_string()).collect(),
            ..RawIssue::default()
        }
    }

    #[test]
    fn a_pr_names_its_own_slice_not_the_ones_it_mentions() {
        assert!(names_as_own("Slice #768, PR for the endpoint", 768));
        assert!(names_as_own("\n#768: the endpoint\n\nunblocks #769", 768));
        assert!(!names_as_own("\n#768: the endpoint\n\nunblocks #769", 769));
        assert!(!names_as_own("Closes #7680", 768));
        assert!(!names_as_own("Evidence:\n```\nSlice #616\n```\n", 616));
    }

    fn pr(number: u32, open: bool, body: &str) -> RawPr {
        RawPr {
            number,
            url: format!("p{number}"),
            open,
            merged: !open,
            body: body.into(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_slice_was_last_active_when_it_or_its_open_pr_last_changed() {
        let at = |issue: &str, prs: &[(bool, &str)]| {
            let t = RawIssue {
                updated_at: issue.into(),
                xrefs: prs
                    .iter()
                    .enumerate()
                    .map(|(i, (open, when))| RawPr {
                        updated_at: (*when).into(),
                        ..pr(i as u32 + 1, *open, "Slice #5")
                    })
                    .collect(),
                ..slice_issue(5, &["ready-for-agent"])
            };
            slice(&t, None, &[]).active
        };
        assert_eq!(at("2026-10-01T00:00:00Z", &[]), "2026-10-01T00:00:00Z");
        assert_eq!(
            at("2026-10-01T00:00:00Z", &[(true, "2026-10-04T00:00:00Z")]),
            "2026-10-04T00:00:00Z"
        );
        // A merged PR is history, not activity.
        assert_eq!(
            at("2026-10-01T00:00:00Z", &[(false, "2026-10-04T00:00:00Z")]),
            "2026-10-01T00:00:00Z"
        );
    }

    #[test]
    fn a_check_belongs_to_the_slice_it_was_written_from() {
        let owner = ["check:owner".to_string()];
        let c = check(
            50,
            "Check: it works",
            "c50",
            true,
            &owner,
            "From slice #15 (PR #42), after merge.\n\n**Due:** when #829 is done",
        )
        .unwrap();
        assert_eq!((c.kind.as_str(), c.slice), ("owner", Some(15)));
        assert_eq!(c.due.as_deref(), Some("when #829 is done"));
        assert_eq!(
            check(51, "x", "u", true, &owner, "Once #637 lands, for #15.")
                .unwrap()
                .slice,
            Some(637)
        );
        assert!(check(52, "x", "u", true, &["bug".to_string()], "From slice #15").is_none());
        assert_eq!(
            check(53, "x", "u", true, &owner, "Background `#111114`, then (#15).")
                .unwrap()
                .slice,
            Some(15)
        );
    }

    #[test]
    fn a_tickets_sub_issues_are_its_slices_and_build_labelled_tickets_are_slices_too() {
        let ready = slice_issue(10, &["ready-for-agent", "size:m"]);
        let mut built = slice_issue(11, &["ready-for-agent"]);
        built.open = false;
        built.xrefs = vec![pr(40, false, "Slice #11.")];
        let mut blocked = slice_issue(12, &["ready-for-agent", "escalate"]);
        blocked.blocked_by = vec![blocker(10, true)];
        let mut building = slice_issue(13, &["ready-for-agent"]);
        building.xrefs = vec![pr(41, true, "#13: build it")];
        let mut claimed = slice_issue(14, &["ready-for-agent"]);
        claimed.assignees = vec!["calin".into()];
        claimed.comments = vec![comment("calin")];
        let mut shipped = slice_issue(15, &["ready-for-agent"]);
        shipped.xrefs = vec![pr(42, false, "Builds #15."), pr(43, false, "Slice #99; unblocks #15.")];
        let mut dropped = slice_issue(16, &["ready-for-agent"]);
        dropped.open = false;
        dropped.not_planned = true;
        let checks = [Check {
            parent: Some(2),
            ..check(50, "Check", "c50", true, &["check:owner".into()], "From slice #15.").unwrap()
        }];
        let subs = [ready, built, blocked, building, claimed, shipped, dropped];
        let kids = slices_of(2, &subs, &checks);
        let sl = |n: u32| kids.iter().find(|s| s.num == n).unwrap();
        assert_eq!(sl(10).state, SliceState::Ready);
        assert_eq!(sl(11).state, SliceState::Built);
        assert_eq!(sl(12).state, SliceState::Blocked);
        assert_eq!(sl(13).state, SliceState::Building);
        assert_eq!(sl(14).state, SliceState::Building);
        assert_eq!(sl(15).state, SliceState::Ready);
        assert_eq!(sl(16).state, SliceState::Dropped);
        assert_eq!(sl(10).parent, Some(2));
        assert_eq!(sl(10).size.as_deref(), Some("m"));
        assert!(sl(12).escalate);
        assert_eq!(sl(11).pr.as_ref().map(|p| p.num), Some(40));
        assert_eq!(sl(13).pr.as_ref().map(|p| p.num), Some(41));
        assert_eq!(sl(15).shipped.as_ref().map(|p| p.num), Some(42));
        assert_eq!(sl(15).checks[0].num, 50);
        assert!(sl(14).checks.is_empty());

        let mut fold = issue(2);
        fold.open = false;
        fold.sub_total = 7;
        fold.sub_closed = 2;
        let human = slice_issue(17, &["ready-for-human"]);
        let elsewhere = Check {
            num: 60,
            parent: Some(900),
            ..checks[0].clone()
        };
        let m = build(map(""), vec![fold, issue(3), human], &[checks[0].clone(), elsewhere]);
        assert_eq!(
            m.tickets.iter().map(|t| t.num).collect::<Vec<_>>(),
            [2, 3],
            "17 is a slice, not a decision"
        );
        assert_eq!(m.slice(17).unwrap().state, SliceState::Human);
        assert_eq!(m.slice(17).unwrap().parent, None);
        assert_eq!(m.ticket(2).unwrap().slices, Some(SliceCount { total: 7, closed: 2 }));
        assert_eq!(m.ticket(3).unwrap().slices, None);
        assert_eq!(
            m.checks.iter().map(|c| c.num).collect::<Vec<_>>(),
            [50],
            "60 is another map's"
        );
    }

    #[test]
    fn closed_tickets_are_resolved_or_out_of_scope_with_their_comments_as_the_answer() {
        let mut done = issue(2);
        done.open = false;
        done.comments = vec![RawComment {
            author: "a".into(),
            body: "Yes.".into(),
        }];
        let mut dropped = issue(3);
        dropped.open = false;
        dropped.not_planned = true;
        let m = build_(map(""), vec![done, dropped]);
        assert_eq!(status(&m, 2), Status::Resolved);
        assert_eq!(m.ticket(2).unwrap().answer.as_deref(), Some("Yes."));
        assert_eq!(status(&m, 3), Status::OutOfScope);
        assert_eq!(
            m.counts,
            Counts {
                total: 2,
                resolved: 1,
                out_of_scope: 1,
                ..Counts::default()
            }
        );
    }

    #[test]
    fn a_claim_holds_only_once_the_assignee_has_commented() {
        let mut claimed = issue(2);
        claimed.assignees = vec!["me".into()];
        claimed.comments = vec![comment("me")];
        let mut abandoned = issue(3);
        abandoned.assignees = vec!["me".into()];
        abandoned.comments = vec![comment("someone-else")];
        let m = build_(map(""), vec![claimed, abandoned]);
        assert_eq!(status(&m, 2), Status::Claimed);
        assert!(!m.ticket(2).unwrap().stale_claim);
        assert_eq!(status(&m, 3), Status::Frontier);
        assert!(m.ticket(3).unwrap().stale_claim);
    }

    #[test]
    fn an_open_blocker_on_or_off_the_map_keeps_a_ticket_off_the_frontier() {
        let a = issue(2);
        let mut b = issue(3);
        b.blocked_by = vec![blocker(2, true)];
        let mut c = issue(4);
        c.blocked_by = vec![blocker(99, true)];
        let mut d = issue(5);
        d.blocked_by = vec![blocker(98, false)];
        let m = build_(map(""), vec![a, b, c, d]);
        assert_eq!(status(&m, 2), Status::Frontier);
        assert_eq!(status(&m, 3), Status::Blocked);
        assert_eq!(status(&m, 4), Status::Blocked);
        assert_eq!(
            m.ticket(4).unwrap().outside_blockers,
            vec![OutsideBlocker {
                num: 99,
                title: "Ticket 99".into(),
                open: true
            }]
        );
        assert_eq!(status(&m, 5), Status::Frontier);
        assert_eq!(
            m.edges,
            vec![Edge {
                from: 2,
                to: 3,
                satisfied: false
            }]
        );
    }

    #[test]
    fn rank_is_one_past_the_deepest_blocker_and_a_cycle_does_not_spin() {
        let a = issue(2);
        let mut b = issue(3);
        b.blocked_by = vec![blocker(2, true)];
        let mut c = issue(4);
        c.blocked_by = vec![blocker(3, true), blocker(2, true)];
        let mut x = issue(5);
        x.blocked_by = vec![blocker(6, true)];
        let mut y = issue(6);
        y.blocked_by = vec![blocker(5, true)];
        let m = build_(map(""), vec![c, b, a, x, y]);
        let r: Vec<(u32, u32)> = m.tickets.iter().map(|t| (t.num, t.rank)).collect();
        assert_eq!(&r[..3], &[(2, 0), (3, 1), (4, 2)]);
    }

    #[test]
    fn the_body_gives_destination_gists_and_fog_ignoring_fenced_headings() {
        let body = "## Destination\n\nSomewhere good.\n\n## Notes\n\n```\n## Decisions so far\n```\n\n\
## Decisions so far\n\n- [Ticket 2](https://github.com/o/r/issues/2): yes, and [Ticket 3](https://github.com/o/r/issues/3) later.\n\n\
## Not yet specified\n\n- **Today's row.** Whether today stands out. <clears-with: 3>\n- A loose patch with no bold title at all, which runs on and on\n";
        let mut done = issue(2);
        done.open = false;
        let m = build_(map(body), vec![done, issue(3)]);
        assert_eq!(m.destination, "Somewhere good.");
        assert_eq!(
            m.ticket(2).unwrap().gist.as_deref(),
            Some("yes, and [Ticket 3](https://github.com/o/r/issues/3) later.")
        );
        assert_eq!(m.ticket(3).unwrap().gist, None);
        assert_eq!(
            m.fog,
            vec![
                Fog {
                    title: "Today's row".into(),
                    text: "Whether today stands out.".into(),
                    clears_with: Some(3)
                },
                Fog {
                    title: "A loose patch with no bold title at all, which r…".into(),
                    text: "A loose patch with no bold title at all, which runs on and on".into(),
                    clears_with: None
                },
            ]
        );
    }

    #[test]
    fn type_comes_from_the_wayfinder_label() {
        let mut t = issue(2);
        t.labels = vec!["bug".into(), "wayfinder:prototype".into()];
        let mut u = issue(3);
        u.labels = vec![];
        let m = build_(map(""), vec![t, u]);
        assert_eq!(m.ticket(2).unwrap().kind, "prototype");
        assert_eq!(m.ticket(3).unwrap().kind, "grilling");
    }
}
