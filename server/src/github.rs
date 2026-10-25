//! Reads maps from GitHub through `gh api graphql`, so starchart holds no token of its own: it
//! runs as whoever `gh` is logged in as. One query returns a map's tickets, their blockers (with
//! the state of blockers off the map) and their comments; another the repo's check issues. A
//! ticket's slices are a query of their own, asked when the ticket is opened.
//!
//! GitHub prices a query by the most nodes its connections could return, not the nodes they do,
//! and it limits reads of sub-issues and dependencies separately, without saying so in
//! `gh api rate_limit`. Asking every ticket for its slices, and every slice for its blockers,
//! spent both within minutes of a map being open; so nothing here nests sub-issues.

use crate::model::{self, Check, Map, RawComment, RawIssue, RawPr, RawRef, Slice};
use crate::spec;
use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tokio::process::Command;

const MAP_QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
number title body url state stateReason
subIssues(first:100){nodes{number title body url state stateReason updatedAt closedAt subIssuesSummary{total completed}
  assignees(first:10){nodes{login}} labels(first:20){nodes{name}}
  blockedBy(first:50){nodes{number title state}}
  comments(first:100){nodes{author{login} body}}
  timelineItems(first:20,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...pr}}}}}}}}}
fragment pr on ReferencedSubject{...on PullRequest{number url state merged body updatedAt}}"#;

const SLICES_QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
subIssues(first:50){nodes{number title body url state stateReason updatedAt closedAt
  assignees(first:5){nodes{login}} labels(first:10){nodes{name}}
  blockedBy(first:20){nodes{number title state}}
  comments(first:20){nodes{author{login}}}
  timelineItems(first:15,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...pr}}}}}}}}}
fragment pr on ReferencedSubject{...on PullRequest{number url state merged body updatedAt}}"#;

const CHECKS_QUERY: &str = r#"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:100,labels:["check:owner","check:agent"],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
number title url state body labels(first:10){nodes{name}}}}}}"#;

const LIST_QUERY: &str = r#"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:100,labels:["wayfinder:map"],orderBy:{field:CREATED_AT,direction:DESC}){nodes{
number title url state subIssuesSummary{total completed}}}}}"#;

/// A map's tickets, asked of each map that has any, as many as it has: whether each is closed,
/// whether it's a slice (by its labels), and how many slices it has and has closed.
const TICKETS: &str = "nodes{state labels(first:10){nodes{name}} subIssuesSummary{total completed}}";

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Progress {
    pub done: u32,
    pub total: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapSummary {
    pub num: u32,
    pub name: String,
    pub url: String,
    pub open: bool,
    /// Its decisions (tickets that aren't slices), closed of all.
    pub decisions: Progress,
    /// Its build slices, closed (built or dropped) of all: those on the map and its tickets'.
    pub build: Progress,
}

#[derive(Clone)]
pub struct GitHub {
    pub gh: String,
}

impl GitHub {
    async fn graphql(&self, query: &str, repo: &str, number: Option<u32>) -> Result<Value> {
        let (owner, name) = repo
            .split_once('/')
            .ok_or_else(|| anyhow!("repo must be owner/name: {repo}"))?;
        let mut cmd = Command::new(&self.gh);
        cmd.args(["api", "graphql", "-f"]).arg(format!("query={query}"));
        cmd.args(["-f"])
            .arg(format!("owner={owner}"))
            .args(["-f"])
            .arg(format!("name={name}"));
        if let Some(n) = number {
            cmd.args(["-F"]).arg(format!("number={n}"));
        }
        let out = cmd.output().await.with_context(|| format!("running {}", self.gh))?;
        let v: Option<Value> = serde_json::from_slice(&out.stdout).ok();
        // A number that isn't an issue answers null with a NOT_FOUND error; the rest of the
        // answer stands, and the caller decides what a null means.
        let only_missing = v
            .as_ref()
            .and_then(|v| v.get("errors")?.as_array())
            .is_some_and(|errs| {
                errs.iter()
                    .all(|e| e.get("type").and_then(Value::as_str) == Some("NOT_FOUND"))
            });
        match v {
            Some(v) if out.status.success() && v.get("errors").is_none() => Ok(v),
            Some(v) if only_missing && v.get("data").is_some_and(|d| !d.is_null()) => Ok(v),
            Some(v) if v.get("errors").is_some() => bail!("GitHub GraphQL errors: {}", v["errors"]),
            _ => bail!("gh api graphql failed: {}", String::from_utf8_lossy(&out.stderr).trim()),
        }
    }

    pub async fn map(&self, repo: &str, number: u32) -> Result<Map> {
        let (v, mut checks) = tokio::try_join!(self.graphql(MAP_QUERY, repo, Some(number)), self.checks(repo))?;
        self.parents(repo, &mut checks).await?;
        parse_map(&v, &checks)
    }

    /// A ticket's build slices.
    pub async fn slices(&self, repo: &str, ticket: u32) -> Result<Vec<Slice>> {
        let (v, checks) = tokio::try_join!(self.graphql(SLICES_QUERY, repo, Some(ticket)), self.checks(repo))?;
        let subs: Vec<RawIssue> = v
            .pointer("/data/repository/issue")
            .map(|i| nodes(i, "subIssues"))
            .into_iter()
            .flatten()
            .map(raw_issue)
            .collect();
        Ok(model::slices_of(ticket, &subs, &checks))
    }

    /// The repo's check issues, newest first.
    async fn checks(&self, repo: &str) -> Result<Vec<Check>> {
        let v = self.graphql(CHECKS_QUERY, repo, None).await?;
        Ok(v.pointer("/data/repository")
            .map(|r| nodes(r, "issues"))
            .into_iter()
            .flatten()
            .filter_map(|i| {
                let labels: Vec<String> = nodes(i, "labels").map(|l| s(l, "name")).collect();
                let open = s(i, "state") == "OPEN";
                model::check(
                    num(i, "number"),
                    &s(i, "title"),
                    &s(i, "url"),
                    open,
                    &labels,
                    &s(i, "body"),
                )
            })
            .collect())
    }

    /// Fills in the parent of each open check's slice, so a map can tell its checks from other
    /// maps'. Open checks are few, so this asks for a few parents.
    async fn parents(&self, repo: &str, checks: &mut [Check]) -> Result<()> {
        let mut wanted: Vec<u32> = checks.iter().filter(|c| c.open).filter_map(|c| c.slice).collect();
        wanted.sort();
        wanted.dedup();
        if wanted.is_empty() {
            return Ok(());
        }
        let asks: String = wanted
            .iter()
            // A check can name a PR first; asking for it as an issue would fail the whole query.
            .map(|n| format!("s{n}:issueOrPullRequest(number:{n}){{...on Issue{{parent{{number}}}}}}"))
            .collect();
        let query = format!("query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{asks}}}}}");
        let got = self.graphql(&query, repo, None).await?;
        for c in checks.iter_mut() {
            c.parent = c
                .slice
                .and_then(|n| got.pointer(&format!("/data/repository/s{n}/parent/number")))
                .and_then(Value::as_u64)
                .map(|p| p as u32);
        }
        Ok(())
    }

    /// The maps, newest first, with their progress. Their tickets are asked of each map for
    /// as many as it has, so the cost follows the tickets there are; see the module notes.
    pub async fn maps(&self, repo: &str) -> Result<Vec<MapSummary>> {
        let v = self.graphql(LIST_QUERY, repo, None).await?;
        let mut list = parse_list(&v)?;
        let asks: String = nodes(&v["data"]["repository"], "issues")
            .filter_map(|i| {
                let total = i.pointer("/subIssuesSummary/total")?.as_u64()?;
                let n = num(i, "number");
                (total > 0).then(|| {
                    format!(
                        "m{n}:issue(number:{n}){{subIssues(first:{}){{{TICKETS}}}}}",
                        total.min(100)
                    )
                })
            })
            .collect();
        if asks.is_empty() {
            return Ok(list);
        }
        let query = format!("query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{asks}}}}}");
        let got = self.graphql(&query, repo, None).await?;
        for m in &mut list {
            if let Some(map) = got.pointer(&format!("/data/repository/m{}", m.num)) {
                (m.decisions, m.build) = progress(map);
            }
        }
        Ok(list)
    }

    /// The map's merged spec PRs, build slices and checks; see `spec`. It reads the slices of
    /// every ticket, which costs, but only when the spec is opened, and the answer is cached.
    pub async fn provenance(&self, repo: &str, number: u32, files: &[&str]) -> Result<spec::Provenance> {
        let (v, checks) = tokio::try_join!(self.graphql(spec::QUERY, repo, Some(number)), self.checks(repo))?;
        let mut v = self.with_subs(repo, v, spec::SLICE_FIELDS).await?;
        let labels = checks
            .iter()
            .map(|c| {
                (
                    c.num,
                    serde_json::json!({"nodes": [{"name": format!("check:{}", c.kind)}]}),
                )
            })
            .collect();
        label_checks(&mut v, &labels);
        spec::parse(&v, files)
    }

    /// Puts each ticket's sub-issues where a nested `subIssues` would have, asking only the
    /// tickets that have any, each for as many as it has.
    async fn with_subs(&self, repo: &str, mut v: Value, fields: &str) -> Result<Value> {
        let parents: Vec<(u32, u64)> = v
            .pointer("/data/repository/issue")
            .map(|i| nodes(i, "subIssues"))
            .into_iter()
            .flatten()
            .filter_map(|t| {
                let total = t.pointer("/subIssuesSummary/total")?.as_u64()?;
                (total > 0).then(|| (num(t, "number"), total.min(100)))
            })
            .collect();
        if parents.is_empty() {
            return Ok(v);
        }
        let asks: String = parents
            .iter()
            .map(|(n, k)| format!("t{n}:issue(number:{n}){{subIssues(first:{k}){{nodes{{{fields}}}}}}}"))
            .collect();
        let query = format!("query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{asks}}}}}");
        let got = self.graphql(&query, repo, None).await?;
        let subs = v
            .pointer_mut("/data/repository/issue/subIssues/nodes")
            .and_then(Value::as_array_mut);
        for t in subs.into_iter().flatten() {
            let n = num(t, "number");
            if let Some(found) = got.pointer(&format!("/data/repository/t{n}/subIssues")) {
                t["subIssues"] = found.clone();
            }
        }
        Ok(v)
    }

    async fn rest(&self, args: &[&str]) -> Result<Option<Vec<u8>>> {
        let out = Command::new(&self.gh)
            .arg("api")
            .args(args)
            .output()
            .await
            .with_context(|| format!("running {}", self.gh))?;
        if out.status.success() {
            return Ok(Some(out.stdout));
        }
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("404") || err.contains("Not Found") {
            return Ok(None);
        }
        bail!("gh api failed: {}", err.trim())
    }

    /// A file's text at a ref, or None when it doesn't exist there.
    pub async fn file_at(&self, repo: &str, path: &str, git_ref: &str) -> Result<Option<String>> {
        let url = format!("repos/{repo}/contents/{path}?ref={git_ref}");
        Ok(self
            .rest(&["-H", "Accept: application/vnd.github.raw", &url])
            .await?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    /// A commit's diff, as each file's patch. GitHub leaves out the patch of a file whose diff is
    /// too large; that file is simply missing.
    pub async fn commit_patches(&self, repo: &str, sha: &str) -> Result<HashMap<String, String>> {
        let Some(body) = self.rest(&[&format!("repos/{repo}/commits/{sha}")]).await? else {
            return Ok(HashMap::new());
        };
        let v: Value = serde_json::from_slice(&body).context("gh returned JSON that doesn't parse")?;
        Ok(v.get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| Some((s(f, "filename"), f.get("patch")?.as_str()?.to_string())))
            .collect())
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}
fn num(v: &Value, k: &str) -> u32 {
    v.get(k).and_then(Value::as_u64).unwrap_or_default() as u32
}
fn nodes<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a Value> {
    v.get(k)
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Gives each referencing issue that is a check its labels; the rest have none.
fn label_checks(v: &mut Value, checks: &HashMap<u32, Value>) {
    match v {
        Value::Object(o) => {
            if o.get("__typename").and_then(Value::as_str) == Some("Issue")
                && let Some(labels) = o
                    .get("number")
                    .and_then(Value::as_u64)
                    .and_then(|n| checks.get(&(n as u32)))
            {
                o.insert("labels".into(), labels.clone());
            }
            o.values_mut().for_each(|x| label_checks(x, checks));
        }
        Value::Array(a) => a.iter_mut().for_each(|x| label_checks(x, checks)),
        _ => {}
    }
}

fn raw_issue(v: &Value) -> RawIssue {
    let reason = s(v, "stateReason");
    RawIssue {
        number: num(v, "number"),
        title: s(v, "title"),
        body: s(v, "body"),
        url: s(v, "url"),
        open: s(v, "state") == "OPEN",
        not_planned: reason == "NOT_PLANNED" || reason == "DUPLICATE",
        assignees: nodes(v, "assignees").map(|a| s(a, "login")).collect(),
        labels: nodes(v, "labels").map(|l| s(l, "name")).collect(),
        blocked_by: nodes(v, "blockedBy")
            .map(|b| RawRef {
                number: num(b, "number"),
                title: s(b, "title"),
                open: s(b, "state") == "OPEN",
            })
            .collect(),
        comments: nodes(v, "comments")
            .map(|c| RawComment {
                author: c.get("author").map(|a| s(a, "login")).unwrap_or_default(),
                body: s(c, "body"),
            })
            .collect(),
        updated_at: s(v, "updatedAt"),
        closed_at: v.get("closedAt").and_then(Value::as_str).map(str::to_string),
        sub_total: v
            .pointer("/subIssuesSummary/total")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        sub_closed: v
            .pointer("/subIssuesSummary/completed")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        xrefs: nodes(v, "timelineItems")
            .filter_map(|t| t.get("source"))
            .filter(|x| x.get("number").is_some())
            .map(|x| RawPr {
                number: num(x, "number"),
                url: s(x, "url"),
                open: s(x, "state") == "OPEN",
                merged: x.get("merged") == Some(&Value::Bool(true)),
                body: s(x, "body"),
                updated_at: s(x, "updatedAt"),
            })
            .collect(),
    }
}

pub fn parse_map(v: &Value, checks: &[Check]) -> Result<Map> {
    let issue = v
        .pointer("/data/repository/issue")
        .filter(|i| !i.is_null())
        .ok_or_else(|| anyhow!("no such issue"))?;
    let subs = nodes(issue, "subIssues").map(raw_issue).collect();
    Ok(model::build(raw_issue(issue), subs, checks))
}

pub fn parse_list(v: &Value) -> Result<Vec<MapSummary>> {
    let repo = v
        .pointer("/data/repository")
        .filter(|r| !r.is_null())
        .ok_or_else(|| anyhow!("no such repository"))?;
    Ok(nodes(repo, "issues")
        .map(|i| MapSummary {
            num: num(i, "number"),
            name: s(i, "title"),
            url: s(i, "url"),
            open: s(i, "state") == "OPEN",
            decisions: Progress::default(),
            build: Progress::default(),
        })
        .collect())
}

/// A map's decisions and build, from its tickets: a build-labelled ticket is a slice; any other
/// is a decision, whose own sub-issues are slices.
pub fn progress(map: &Value) -> (Progress, Progress) {
    let (mut dec, mut build) = (Progress::default(), Progress::default());
    for t in nodes(map, "subIssues") {
        let labels: Vec<String> = nodes(t, "labels").map(|l| s(l, "name")).collect();
        let closed = (s(t, "state") == "CLOSED") as u32;
        if model::is_build(&labels) {
            build.total += 1;
            build.done += closed;
        } else {
            dec.total += 1;
            dec.done += closed;
        }
        if let Some(sum) = t.get("subIssuesSummary") {
            build.total += num(sum, "total");
            build.done += num(sum, "completed");
        }
    }
    (dec, build)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Status;
    use serde_json::json;

    #[test]
    fn only_referencing_issues_that_are_checks_get_labels() {
        let mut v = json!({"subIssues": {"nodes": [{"number": 5, "timelineItems": {"nodes": [
            {"source": {"__typename": "Issue", "number": 90}},
            {"source": {"__typename": "Issue", "number": 91}},
            {"source": {"__typename": "PullRequest", "number": 90}}]}}]}});
        let checks = HashMap::from([(90, json!({"nodes": [{"name": "check:owner"}]}))]);
        label_checks(&mut v, &checks);
        let refs = &v["subIssues"]["nodes"][0]["timelineItems"]["nodes"];
        assert_eq!(refs[0]["source"]["labels"]["nodes"][0]["name"], "check:owner");
        assert!(refs[1]["source"].get("labels").is_none());
        assert!(refs[2]["source"].get("labels").is_none());
    }

    #[test]
    fn a_graphql_answer_becomes_a_map() {
        let v = json!({"data": {"repository": {"issue": {
            "number": 1, "title": "Wayfinder: A map", "body": "## Destination\n\nThere.", "url": "u1", "state": "OPEN",
            "subIssues": {"nodes": [
                {"number": 2, "title": "Done", "body": "", "url": "u2", "state": "CLOSED", "stateReason": "COMPLETED",
                 "assignees": {"nodes": [{"login": "me"}]}, "labels": {"nodes": [{"name": "wayfinder:task"}]},
                 "blockedBy": {"nodes": []}, "comments": {"nodes": [{"author": {"login": "me"}, "body": "Yes."}]}},
                {"number": 3, "title": "Dropped", "body": "", "url": "u3", "state": "CLOSED", "stateReason": "NOT_PLANNED",
                 "assignees": {"nodes": []}, "labels": {"nodes": []}, "blockedBy": {"nodes": []}, "comments": {"nodes": []}},
                {"number": 4, "title": "Next", "body": "", "url": "u4", "state": "OPEN", "stateReason": null,
                 "assignees": {"nodes": []}, "labels": {"nodes": []},
                 "blockedBy": {"nodes": [{"number": 2, "title": "Done", "state": "CLOSED"}]},
                 "comments": {"nodes": [{"author": null, "body": "A ghost."}]}}
            ]}
        }}}});
        let m = parse_map(&v, &[]).unwrap();
        assert_eq!(m.destination, "There.");
        let st: Vec<(u32, Status)> = m.tickets.iter().map(|t| (t.num, t.status)).collect();
        assert_eq!(
            st,
            vec![(2, Status::Resolved), (3, Status::OutOfScope), (4, Status::Frontier)]
        );
        assert_eq!(m.ticket(2).unwrap().kind, "task");
        assert_eq!(m.edges.len(), 1);
        assert!(m.edges[0].satisfied);
    }

    #[test]
    fn a_missing_issue_is_an_error() {
        assert!(parse_map(&json!({"data": {"repository": {"issue": null}}}), &[]).is_err());
    }

    #[test]
    fn a_maps_progress_splits_decisions_from_build_slices() {
        let v = json!({"data": {"repository": {"issues": {"nodes": [
            {"number": 7, "title": "Wayfinder: Seven", "url": "u7", "state": "OPEN", "subIssuesSummary": {"total": 4, "completed": 2}}
        ]}}}});
        let list = parse_list(&v).unwrap();
        assert_eq!((list[0].num, list[0].open), (7, true));
        let map = json!({"subIssues": {"nodes": [
            {"state": "CLOSED", "labels": {"nodes": [{"name": "wayfinder:grilling"}]}, "subIssuesSummary": {"total": 0, "completed": 0}},
            {"state": "CLOSED", "labels": {"nodes": [{"name": "wayfinder:task"}]}, "subIssuesSummary": {"total": 4, "completed": 1}},
            {"state": "OPEN", "labels": {"nodes": [{"name": "wayfinder:research"}]}, "subIssuesSummary": {"total": 0, "completed": 0}},
            {"state": "CLOSED", "labels": {"nodes": [{"name": "size:s"}]}, "subIssuesSummary": {"total": 0, "completed": 0}}
        ]}});
        assert_eq!(
            progress(&map),
            (Progress { done: 2, total: 3 }, Progress { done: 2, total: 5 })
        );
    }
}
