//! Starts and lists T3 Code threads through T3's own `t3` CLI. Starchart never sends a prompt
//! it didn't build: a launch names an action and a ticket on a loaded map, and the prompt is a
//! fixed template around them (the user's note, when there is one, is quoted as theirs).

use crate::model::Map;
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
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub repo: String,
    pub kind: Kind,
    pub map: Option<u32>,
    pub ticket: Option<u32>,
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
                message: format!(
                    "Read the wayfinder map {} ({}) and its ticket {} ({}), with its comments. \
Don't claim, comment on, close or edit anything unless I ask you to. Then answer this:\n\n{}",
                    map.name,
                    map.url,
                    t.title,
                    t.url,
                    note.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
                ),
                branch: None,
            })
        }
        Kind::Next | Kind::Chart => unreachable!("handled above"),
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
    use crate::model::{self, RawIssue};
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
        )
    }
    fn req(kind: Kind, ticket: Option<u32>, note: &str) -> LaunchRequest {
        LaunchRequest {
            repo: "o/r".into(),
            kind,
            map: Some(1),
            ticket,
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
