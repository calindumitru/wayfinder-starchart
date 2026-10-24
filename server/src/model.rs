//! A wayfinder map kept as GitHub issues, turned into the graph the star-map draws.
//!
//! The map is one issue; its sub-issues are the tickets. A ticket's status is derived, never
//! stored: closed as completed is resolved, closed as not planned is out of scope, an open ticket
//! whose assignee has commented on it is claimed, and any other open ticket is on the frontier
//! when every blocker is closed (blockers outside the map count too) and blocked otherwise. An
//! assignee who never commented left an abandoned claim: the ticket is free, flagged `staleClaim`.

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
}

impl Map {
    pub fn ticket(&self, num: u32) -> Option<&Ticket> {
        self.tickets.iter().find(|t| t.num == num)
    }
}

const TYPES: [&str; 4] = ["research", "prototype", "grilling", "task"];

pub fn build(map: RawIssue, mut subs: Vec<RawIssue>) -> Map {
    subs.sort_by_key(|t| t.number);
    let on_map: HashSet<u32> = subs.iter().map(|t| t.number).collect();
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
    fn status(m: &Map, n: u32) -> Status {
        m.ticket(n).unwrap().status
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
        let m = build(map(""), vec![done, dropped]);
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
        let m = build(map(""), vec![claimed, abandoned]);
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
        let m = build(map(""), vec![a, b, c, d]);
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
        let m = build(map(""), vec![c, b, a, x, y]);
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
        let m = build(map(body), vec![done, issue(3)]);
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
        let m = build(map(""), vec![t, u]);
        assert_eq!(m.ticket(2).unwrap().kind, "prototype");
        assert_eq!(m.ticket(3).unwrap().kind, "grilling");
    }
}
