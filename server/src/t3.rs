//! Starts and lists T3 Code threads through T3's own `t3` CLI. Starchart never sends a prompt
//! it didn't build: a launch names an action and a ticket on a loaded map, and the prompt is a
//! fixed template around them (the user's note, when there is one, is quoted as theirs).

use crate::model::{Map, SliceState};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// `/wayfinder <map> <ticket>`: claim the ticket and resolve it as its type says.
    Work,
    /// `/wayfinder <map>`: take the first ticket on the frontier.
    Next,
    /// A conversation about a ticket that claims and changes nothing.
    Ask,
    /// `/wayfinder <idea>`: chart a new map.
    Chart,
    /// `/slice-flow <slice>`: build a slice up to a reviewed, merged PR.
    Build,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub repo: String,
    pub kind: Kind,
    pub map: Option<u32>,
    pub ticket: Option<u32>,
    /// For a slice under a ticket, that ticket: the slices a map carries are only its own.
    #[serde(default)]
    pub parent: Option<u32>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub worktree: bool,
}

#[derive(Debug, PartialEq)]
pub struct Launch {
    pub title: String,
    pub message: String,
    pub branch: Option<String>,
}

const MAX_NOTE: usize = 4000;

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end())
    }
}

fn with_note(mut message: String, note: &str) -> String {
    if !note.is_empty() {
        message.push_str("\n\nThe Owner's note from the map:\n\n");
        for line in note.lines() {
            message.push_str("> ");
            message.push_str(line);
            message.push('\n');
        }
    }
    message
}

/// A question about a ticket or slice, for a session that reads and changes nothing.
fn ask_message(map_name: &str, map_url: &str, what: &str, title: &str, url: &str, note: &str) -> String {
    format!(
        "Read the wayfinder map {map_name} ({map_url}) and its {what} {title} ({url}), with its comments. \
Don't claim, comment on, close or edit anything unless I ask you to. Then answer this:\n\n{}",
        note.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
    )
}

/// The thread to start for a request, checked against the map it names. A ticket's thread is
/// titled `#<n> <title>` so starchart can find it again in `t3 thread list`.
pub fn plan(req: &LaunchRequest, map: Option<&Map>) -> Result<Launch> {
    let note = req.note.trim();
    if note.chars().count() > MAX_NOTE {
        bail!("the note is longer than {MAX_NOTE} characters");
    }
    if req.kind == Kind::Chart {
        if note.is_empty() {
            bail!("charting a map needs the idea");
        }
        return Ok(Launch {
            title: clip(&format!("Chart: {}", note.lines().next().unwrap_or(note)), 80),
            message: format!("/wayfinder {note}"),
            branch: None,
        });
    }
    let Some(map) = map else {
        bail!("this action needs a map")
    };
    if req.kind == Kind::Next {
        return Ok(Launch {
            title: clip(&format!("Next on {}", map.name), 80),
            message: with_note(format!("/wayfinder {}", map.url), note),
            branch: None,
        });
    }
    if req.kind == Kind::Build {
        let Some(sl) = req.ticket.and_then(|n| map.slice(n)) else {
            bail!("that slice isn't on this map")
        };
        match sl.state {
            SliceState::Built | SliceState::Dropped => bail!("that slice is closed"),
            SliceState::Human => bail!("that slice needs a human first"),
            SliceState::Blocked => bail!("that slice is blocked"),
            SliceState::Building => bail!("that slice is already being built"),
            SliceState::Ready => {}
        }
        return Ok(Launch {
            title: clip(&format!("#{} {}", sl.num, sl.title), 80),
            message: with_note(format!("/slice-flow {}", sl.url), note),
            branch: None,
        });
    }
    // Ask works on a slice as well as a ticket; everything else needs a ticket.
    if req.kind == Kind::Ask
        && let Some(sl) = req.ticket.and_then(|n| map.slice(n))
    {
        if note.is_empty() {
            bail!("asking needs a question");
        }
        return Ok(Launch {
            title: clip(&format!("#{} {}", sl.num, sl.title), 80),
            message: ask_message(&map.name, &map.url, "build slice", &sl.title, &sl.url, note),
            branch: None,
        });
    }
    let Some(t) = req.ticket.and_then(|n| map.ticket(n)) else {
        bail!("that ticket isn't on this map")
    };
    let title = clip(&format!("#{} {}", t.num, t.title), 80);
    match req.kind {
        Kind::Work => {
            if !t.status.is_open() {
                bail!("that ticket is closed");
            }
            Ok(Launch {
                title,
                message: with_note(format!("/wayfinder {} {}", map.url, t.url), note),
                branch: req.worktree.then(|| format!("wayfinder/{}-{}", t.num, slug(&t.title))),
            })
        }
        Kind::Ask => {
            if note.is_empty() {
                bail!("asking needs a question");
            }
            Ok(Launch {
                title,
                message: ask_message(&map.name, &map.url, "ticket", &t.title, &t.url, note),
                branch: None,
            })
        }
        Kind::Next | Kind::Chart | Kind::Build => unreachable!("handled above"),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub thread_id: String,
    pub title: String,
    pub status: String,
    pub settled: bool,
    /// The ticket a `#<n> …` title names.
    pub ticket: Option<u32>,
}

pub fn parse_threads(v: &Value) -> Vec<Thread> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let title = t.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
            let ticket = title
                .strip_prefix('#')
                .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|d| d.parse().ok());
            Thread {
                thread_id: t
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                status: t.get("status").and_then(Value::as_str).unwrap_or_default().to_string(),
                settled: t.get("settled").and_then(Value::as_bool).unwrap_or(false),
                title,
                ticket,
            }
        })
        .collect()
}

pub struct T3 {
    pub bin: String,
    pub worktree_base: String,
}

/// The id of this machine's T3 environment, which a `t3code://threads/<environment>/<thread>`
/// link needs to open a thread in the app. T3 keeps it in its data directory: `$T3CODE_HOME`,
/// or `~/.t3` by default.
pub fn environment_id() -> Option<String> {
    let home = std::env::var("T3CODE_HOME")
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.t3")))?;
    let id = std::fs::read_to_string(format!("{home}/userdata/environment-id")).ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| id.to_string())
}

impl T3 {
    pub async fn start(&self, project: &str, launch: &Launch) -> Result<Value> {
        let mut cmd = Command::new(&self.bin);
        cmd.args(["thread", "start", "--json", "--title", &launch.title]);
        if let Some(b) = &launch.branch {
            cmd.args(["--worktree", &self.worktree_base, "--branch", b]);
        }
        cmd.args([project, "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().with_context(|| format!("running {}", self.bin))?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin.write_all(launch.message.as_bytes()).await?;
        drop(stdin);
        let out = child.wait_with_output().await?;
        if !out.status.success() {
            bail!(
                "t3 thread start failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.trim().to_string())))
    }

    pub async fn threads(&self, project: &str) -> Result<Vec<Thread>> {
        let out = Command::new(&self.bin)
            .args(["thread", "list", "--json", "--project", project])
            .output()
            .await
            .with_context(|| format!("running {}", self.bin))?;
        if !out.status.success() {
            bail!("t3 thread list failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(parse_threads(
            &serde_json::from_slice(&out.stdout).context("t3 returned JSON that doesn't parse")?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{self, RawIssue, RawPr};
    use serde_json::json;

    fn map() -> Map {
        let ticket = |number: u32, title: &str, open: bool| RawIssue {
            number,
            title: title.into(),
            url: format!("https://github.com/o/r/issues/{number}"),
            open,
            ..RawIssue::default()
        };
        model::build(
            RawIssue {
                number: 1,
                title: "Wayfinder: A map".into(),
                url: "https://github.com/o/r/issues/1".into(),
                ..RawIssue::default()
            },
            vec![
                ticket(2, "Which colour should the button be?", true),
                ticket(3, "Done already", false),
            ],
            &[],
        )
    }
    fn req(kind: Kind, ticket: Option<u32>, note: &str) -> LaunchRequest {
        LaunchRequest {
            repo: "o/r".into(),
            kind,
            map: Some(1),
            ticket,
            parent: None,
            note: note.into(),
            worktree: false,
        }
    }

    #[test]
    fn work_runs_wayfinder_on_the_map_and_ticket() {
        let l = plan(&req(Kind::Work, Some(2), ""), Some(&map())).unwrap();
        assert_eq!(
            l,
            Launch {
                title: "#2 Which colour should the button be?".into(),
                message: "/wayfinder https://github.com/o/r/issues/1 https://github.com/o/r/issues/2".into(),
                branch: None
            }
        );
    }

    #[test]
    fn a_worktree_gets_a_branch_named_for_the_ticket_and_a_note_is_quoted() {
        let mut r = req(Kind::Work, Some(2), "Start with blue.\nKeep it short.");
        r.worktree = true;
        let l = plan(&r, Some(&map())).unwrap();
        assert_eq!(
            l.branch.as_deref(),
            Some("wayfinder/2-which-colour-should-the-button-be")
        );
        assert!(
            l.message
                .ends_with("note from the map:\n\n> Start with blue.\n> Keep it short.\n")
        );
    }

    #[test]
    fn work_refuses_a_closed_ticket_or_one_off_the_map() {
        assert!(plan(&req(Kind::Work, Some(3), ""), Some(&map())).is_err());
        assert!(plan(&req(Kind::Work, Some(99), ""), Some(&map())).is_err());
    }

    #[test]
    fn ask_needs_a_question_and_works_on_a_closed_ticket() {
        assert!(plan(&req(Kind::Ask, Some(3), " "), Some(&map())).is_err());
        let l = plan(&req(Kind::Ask, Some(3), "Why?"), Some(&map())).unwrap();
        assert!(l.message.contains("Don't claim"));
        assert!(l.message.ends_with("> Why?"));
    }

    #[test]
    fn build_starts_slice_flow_only_on_a_ready_slice() {
        let sl = |number: u32, pr: Option<(u32, bool)>| RawIssue {
            number,
            title: format!("Slice {number}"),
            url: format!("https://github.com/o/r/issues/{number}"),
            open: true,
            labels: vec!["ready-for-agent".into()],
            xrefs: pr
                .map(|(n, open)| RawPr {
                    number: n,
                    url: "p".into(),
                    open,
                    merged: !open,
                    body: format!("Slice #{number}"),
                })
                .into_iter()
                .collect(),
            ..RawIssue::default()
        };
        let fold = RawIssue {
            number: 2,
            title: "Fold it in".into(),
            url: "https://github.com/o/r/issues/2".into(),
            ..RawIssue::default()
        };
        let mut m = model::build(
            RawIssue {
                number: 1,
                title: "Wayfinder: A map".into(),
                url: "https://github.com/o/r/issues/1".into(),
                ..RawIssue::default()
            },
            vec![fold],
            &[],
        );
        // A ticket's slices come on their own; the launch adds them to the map it reads.
        let subs = [sl(10, None), sl(11, Some((40, true))), sl(12, Some((41, false)))];
        m.slices.extend(model::slices_of(2, &subs, &[]));
        let l = plan(&req(Kind::Build, Some(10), ""), Some(&m)).unwrap();
        assert_eq!(l.message, "/slice-flow https://github.com/o/r/issues/10");
        assert_eq!(l.title, "#10 Slice 10");
        let err = |n| plan(&req(Kind::Build, Some(n), ""), Some(&m)).unwrap_err().to_string();
        assert!(err(11).contains("already being built"));
        // A merged PR naming it is a warning in the UI, not a refusal: the rule can be wrong.
        assert!(plan(&req(Kind::Build, Some(12), ""), Some(&m)).is_ok());
        assert!(err(2).contains("isn't on this map"));
        let a = plan(&req(Kind::Ask, Some(10), "Which table?"), Some(&m)).unwrap();
        assert!(a.message.contains("build slice Slice 10"));
    }

    #[test]
    fn next_and_chart() {
        assert_eq!(
            plan(&req(Kind::Next, None, ""), Some(&map())).unwrap().message,
            "/wayfinder https://github.com/o/r/issues/1"
        );
        let mut c = req(Kind::Chart, None, "Offline mode for the app");
        c.map = None;
        assert_eq!(plan(&c, None).unwrap().message, "/wayfinder Offline mode for the app");
        c.note = String::new();
        assert!(plan(&c, None).is_err());
    }

    #[test]
    fn threads_titled_with_a_ticket_number_name_it() {
        let v = json!([
            {"threadId": "a", "title": "#42 Which colour", "status": "running", "settled": false},
            {"threadId": "b", "title": "Explore maps", "status": "idle", "settled": true}
        ]);
        let t = parse_threads(&v);
        assert_eq!(t[0].ticket, Some(42));
        assert_eq!(t[1].ticket, None);
        assert!(t[1].settled);
    }
}
