//! Reads maps from GitHub through `gh api graphql`, so starchart holds no token of its own: it
//! runs as whoever `gh` is logged in as. One query returns a whole map, its tickets, their
//! blockers (with the state of blockers off the map) and their comments.

use crate::model::{self, Map, RawComment, RawIssue, RawRef};
use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

const MAP_QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
number title body url state stateReason
subIssues(first:100){nodes{number title body url state stateReason
  assignees(first:10){nodes{login}} labels(first:20){nodes{name}}
  blockedBy(first:50){nodes{number title state}}
  comments(first:100){nodes{author{login} body}}}}}}}"#;

const LIST_QUERY: &str = r#"query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:100,labels:["wayfinder:map"],orderBy:{field:CREATED_AT,direction:DESC}){nodes{
number title url state subIssuesSummary{total completed}}}}}"#;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapSummary {
    pub num: u32,
    pub name: String,
    pub url: String,
    pub open: bool,
    pub total: u32,
    pub completed: u32,
}

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
        if !out.status.success() {
            bail!("gh api graphql failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        let v: Value = serde_json::from_slice(&out.stdout).context("gh returned JSON that doesn't parse")?;
        if let Some(errs) = v.get("errors") {
            bail!("GitHub GraphQL errors: {errs}");
        }
        Ok(v)
    }

    pub async fn map(&self, repo: &str, number: u32) -> Result<Map> {
        parse_map(&self.graphql(MAP_QUERY, repo, Some(number)).await?)
    }

    pub async fn maps(&self, repo: &str) -> Result<Vec<MapSummary>> {
        parse_list(&self.graphql(LIST_QUERY, repo, None).await?)
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
    }
}

pub fn parse_map(v: &Value) -> Result<Map> {
    let issue = v
        .pointer("/data/repository/issue")
        .filter(|i| !i.is_null())
        .ok_or_else(|| anyhow!("no such issue"))?;
    let subs = nodes(issue, "subIssues").map(raw_issue).collect();
    Ok(model::build(raw_issue(issue), subs))
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
            total: i.get("subIssuesSummary").map(|x| num(x, "total")).unwrap_or_default(),
            completed: i
                .get("subIssuesSummary")
                .map(|x| num(x, "completed"))
                .unwrap_or_default(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Status;
    use serde_json::json;

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
        let m = parse_map(&v).unwrap();
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
        assert!(parse_map(&json!({"data": {"repository": {"issue": null}}})).is_err());
    }

    #[test]
    fn the_map_list_carries_progress() {
        let v = json!({"data": {"repository": {"issues": {"nodes": [
            {"number": 7, "title": "Wayfinder: Seven", "url": "u7", "state": "OPEN", "subIssuesSummary": {"total": 5, "completed": 2}}
        ]}}}});
        assert_eq!(
            parse_list(&v).unwrap(),
            vec![MapSummary {
                num: 7,
                name: "Wayfinder: Seven".into(),
                url: "u7".into(),
                open: true,
                total: 5,
                completed: 2
            }]
        );
    }
}
