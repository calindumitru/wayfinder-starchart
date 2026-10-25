//! A closed map's spec: the sections of the spec file (and the glossary) that the map's merged
//! PRs changed, as they read on the default branch now, each flagged when it has changed since
//! the PR that last touched it. Plus the work that grew from the map: its build slices and the
//! agent and owner checks that hang off them.
//!
//! Which PRs count: merged PRs that reference a ticket on the map (or the map) and touch the spec
//! or glossary file. Which sections they changed: the merge commit's diff, its changed lines
//! mapped onto the headings of the file as it stood at that commit.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecPr {
    pub num: u32,
    pub title: String,
    pub url: String,
    pub merged_at: String,
    /// It changed code too (any file that isn't Markdown): the spec and its build landed together.
    pub code: bool,
    #[serde(skip)]
    pub sha: String,
    #[serde(skip)]
    pub files: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub num: u32,
    pub title: String,
    pub url: String,
    pub open: bool,
    /// Closed as not planned (or a duplicate): dropped, not built.
    pub dropped: bool,
    pub labels: Vec<String>,
    /// The spec sections its body cites, as numbers: "§3.11" is "3.11".
    pub refs: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub num: u32,
    pub title: String,
    pub url: String,
    pub open: bool,
    /// `owner` or `agent`, from the `check:` label.
    pub kind: String,
}

/// What the provenance query says about a map, before any file is read.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub default_branch: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub prs: Vec<SpecPr>,
    pub slices: Vec<Slice>,
    pub checks: Vec<Check>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    /// Its number, when the heading has one ("3.11"); slices cite sections by it.
    pub number: Option<String>,
    pub level: usize,
    pub anchor: String,
    /// The section as it reads on the default branch now; empty when it's gone.
    pub text: String,
    /// The section no longer matches what the last PR to touch it left.
    pub changed_since: bool,
    /// No heading of this name remains on the default branch.
    pub removed: bool,
    /// The file at that PR's merge commit, at this section.
    pub merged_url: String,
    pub prs: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub file: String,
    /// The file exists on the default branch.
    pub found: bool,
    pub sections: Vec<Section>,
    /// The file's link reference definitions (`[name]: url`), which usually sit at its end, so a
    /// section shown alone can still resolve `[text][name]`.
    pub refs: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub created_at: String,
    pub closed_at: Option<String>,
    pub spec_file: String,
    pub prs: Vec<SpecPr>,
    pub docs: Vec<Doc>,
    pub slices: Vec<Slice>,
    pub checks: Vec<Check>,
}

pub const QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
defaultBranchRef{name}
issue(number:$number){createdAt closedAt
timelineItems(first:30,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...src}}}}
subIssues(first:100){nodes{number title url state stateReason body subIssuesSummary{total} labels(first:10){nodes{name}}
  timelineItems(first:30,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...src}}}}}}}}}
fragment src on ReferencedSubject{__typename
  ...on PullRequest{number title url merged mergedAt mergeCommit{oid} files(first:60){nodes{path}}}
  ...on Issue{number title url state}}"#;

/// A ticket's slices, asked of each ticket that has any. Their references are only read for
/// checks, whose labels `GitHub::provenance` fills in.
pub const SLICE_FIELDS: &str = "number title url state stateReason body labels(first:10){nodes{name}}
  timelineItems(first:20,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{
    __typename ...on Issue{number title url state}}}}}";

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}
fn num(v: &Value, k: &str) -> u32 {
    v.get(k).and_then(Value::as_u64).unwrap_or_default() as u32
}
fn nodes<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a Value> {
    v.get(k)
        .and_then(|x| x.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}
fn labels(v: &Value) -> Vec<String> {
    nodes(v, "labels").map(|l| s(l, "name")).collect()
}
fn sources(v: &Value) -> impl Iterator<Item = &Value> {
    nodes(v, "timelineItems").filter_map(|t| t.get("source"))
}

/// A build slice is a sub-issue of a map ticket (a fold-in's slices), or a ticket on the map that
/// carries a build label rather than a `wayfinder:` type.
fn is_build(labels: &[String]) -> bool {
    labels
        .iter()
        .any(|l| l == "ready-for-agent" || l == "ready-for-human" || l.starts_with("size:"))
}

pub fn parse(v: &Value, files: &[&str]) -> anyhow::Result<Provenance> {
    let repo = v
        .pointer("/data/repository")
        .ok_or_else(|| anyhow::anyhow!("no repository in the answer"))?;
    let issue = repo
        .get("issue")
        .filter(|i| !i.is_null())
        .ok_or_else(|| anyhow::anyhow!("no such issue"))?;
    let mut prs: BTreeMap<u32, SpecPr> = BTreeMap::new();
    let mut take_pr = |src: &Value| {
        if s(src, "__typename") != "PullRequest" || src.get("merged") != Some(&Value::Bool(true)) {
            return;
        }
        let paths: Vec<String> = nodes(src, "files").map(|f| s(f, "path")).collect();
        let code = paths.iter().any(|p| !p.ends_with(".md"));
        let touched: Vec<String> = paths.into_iter().filter(|p| files.contains(&p.as_str())).collect();
        let sha = src
            .pointer("/mergeCommit/oid")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if touched.is_empty() || sha.is_empty() {
            return;
        }
        prs.entry(num(src, "number")).or_insert(SpecPr {
            num: num(src, "number"),
            title: s(src, "title"),
            url: s(src, "url"),
            merged_at: s(src, "mergedAt"),
            code,
            sha: sha.to_string(),
            files: touched,
        });
    };
    sources(issue).for_each(&mut take_pr);
    // A PR merged after the map closed isn't the map's, however it mentions a ticket on it: the
    // fold-ins that write the spec close before the map does. (ISO timestamps compare as text.)
    let closed_at = issue.get("closedAt").and_then(Value::as_str);
    let mut slices: BTreeMap<u32, Slice> = BTreeMap::new();
    let mut checks: BTreeMap<u32, Check> = BTreeMap::new();
    let mut take_check = |src: &Value| {
        if s(src, "__typename") != "Issue" {
            return;
        }
        let kind = labels(src)
            .iter()
            .find_map(|l| l.strip_prefix("check:").map(str::to_string));
        if let Some(kind) = kind {
            checks.entry(num(src, "number")).or_insert(Check {
                num: num(src, "number"),
                title: s(src, "title"),
                url: s(src, "url"),
                open: s(src, "state") == "OPEN",
                kind,
            });
        }
    };
    let slice = |v: &Value| Slice {
        num: num(v, "number"),
        title: s(v, "title"),
        url: s(v, "url"),
        open: s(v, "state") == "OPEN",
        dropped: matches!(s(v, "stateReason").as_str(), "NOT_PLANNED" | "DUPLICATE"),
        labels: labels(v),
        refs: section_refs(&s(v, "body")),
    };
    for t in nodes(issue, "subIssues") {
        sources(t).for_each(&mut take_pr);
        if is_build(&labels(t)) {
            slices.insert(num(t, "number"), slice(t));
            sources(t).for_each(&mut take_check);
        }
        for sl in nodes(t, "subIssues") {
            slices.insert(num(sl, "number"), slice(sl));
            sources(sl).for_each(&mut take_check);
        }
    }
    if let Some(c) = closed_at {
        prs.retain(|_, p| p.merged_at.as_str() <= c);
    }
    Ok(Provenance {
        default_branch: repo
            .pointer("/defaultBranchRef/name")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_string(),
        created_at: s(issue, "createdAt"),
        closed_at: issue.get("closedAt").and_then(Value::as_str).map(str::to_string),
        prs: prs.into_values().collect(),
        slices: slices.into_values().collect(),
        checks: checks.into_values().collect(),
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Heading {
    pub level: usize,
    pub title: String,
    /// 1-based line of the heading.
    pub line: usize,
}

/// The file's Markdown headings, skipping any inside a code fence.
pub fn headings(text: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut fence = false;
    for (i, l) in text.lines().enumerate() {
        let t = l.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        let level = t.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level) && t[level..].starts_with(' ') {
            out.push(Heading {
                level,
                title: t[level..].trim().trim_end_matches('#').trim().to_string(),
                line: i + 1,
            });
        }
    }
    out
}

/// The lines a unified diff touches, as line numbers in the new file: each added line, and for
/// a pure deletion the line it was removed before.
pub fn changed_lines(patch: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut new_line = 0usize;
    for l in patch.lines() {
        if let Some(h) = l.strip_prefix("@@ ") {
            // @@ -a,b +c,d @@
            new_line = h
                .split_whitespace()
                .find_map(|p| p.strip_prefix('+'))
                .and_then(|p| p.split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(1);
        } else if l.starts_with('+') {
            out.push(new_line);
            new_line += 1;
        } else if l.starts_with('-') {
            out.push(new_line.max(1));
        } else if !l.starts_with('\\') {
            new_line += 1;
        }
    }
    out
}

/// The innermost section (a heading below the title) a line sits in.
pub fn section_at(heads: &[Heading], line: usize) -> Option<&Heading> {
    heads.iter().rev().find(|h| h.level >= 2 && h.line <= line)
}

/// A section's own text: its heading line down to the next heading of any level.
pub fn section_text(text: &str, heads: &[Heading], title: &str) -> Option<String> {
    let at = heads.iter().position(|h| h.level >= 2 && h.title == title)?;
    let start = heads[at].line;
    let end = heads.get(at + 1).map(|h| h.line).unwrap_or(usize::MAX);
    let body: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(i, _)| *i + 1 >= start && *i + 1 < end)
        .map(|(_, l)| l)
        .collect();
    Some(body.join("\n").trim_end().to_string())
}

/// The link reference definitions in a Markdown file, outside code fences.
pub fn link_refs(text: &str) -> String {
    let mut fence = false;
    let mut out = Vec::new();
    for l in text.lines() {
        let t = l.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if !fence && t.starts_with('[') && !t.starts_with("[^") && t.contains("]: ") {
            out.push(t);
        }
    }
    out.join("\n")
}

/// The spec sections a text cites: every "§3.11" (or "§ 3.11"), as "3.11", in order, once each.
pub fn section_refs(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r"§\s?(\d+(?:\.\d+)*)").expect("valid pattern");
    let mut out: Vec<String> = Vec::new();
    for c in re.captures_iter(text) {
        let n = c[1].to_string();
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// A heading's section number: "3.11 Shared-in links" is "3.11", "4. Accounts" is "4", and a
/// heading without one has none.
pub fn section_number(title: &str) -> Option<String> {
    let re = regex::Regex::new(r"^(\d+(?:\.\d+)*)\.?\s").expect("valid pattern");
    re.captures(title).map(|c| c[1].to_string())
}

/// GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens.
pub fn anchor(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .map(|c| if c == ' ' { '-' } else { c })
        .collect()
}

/// One file's touched sections, from each PR's patch and the file at its merge commit, read
/// against the file on the default branch now. PRs are taken oldest first, so a section's
/// "as merged" is the last PR to touch it.
pub fn sections(
    repo: &str,
    file: &str,
    current: Option<&str>,
    prs: &[(&SpecPr, Option<String>, Option<String>)],
) -> Vec<Section> {
    let cur_heads = current.map(headings).unwrap_or_default();
    let mut found: HashMap<String, Section> = HashMap::new();
    let mut seen_order: Vec<String> = Vec::new();
    for (pr, patch, at_merge) in prs {
        let (Some(patch), Some(at_merge)) = (patch, at_merge) else {
            continue;
        };
        let heads = headings(at_merge);
        let touched: HashSet<String> = changed_lines(patch)
            .into_iter()
            .filter_map(|l| section_at(&heads, l).map(|h| h.title.clone()))
            .collect();
        for title in touched {
            let then = section_text(at_merge, &heads, &title).unwrap_or_default();
            let now = current.and_then(|c| section_text(c, &cur_heads, &title));
            let level = heads.iter().find(|h| h.title == title).map(|h| h.level).unwrap_or(2);
            let entry = found.entry(title.clone()).or_insert_with(|| {
                seen_order.push(title.clone());
                Section {
                    title: title.clone(),
                    number: section_number(&title),
                    level,
                    anchor: anchor(&title),
                    text: String::new(),
                    changed_since: false,
                    removed: false,
                    merged_url: String::new(),
                    prs: Vec::new(),
                }
            });
            entry.removed = now.is_none();
            entry.changed_since = now.as_deref().is_some_and(|n| n.trim() != then.trim());
            entry.text = now.unwrap_or_default();
            entry.merged_url = format!("https://github.com/{repo}/blob/{}/{file}#{}", pr.sha, anchor(&title));
            if !entry.prs.contains(&pr.num) {
                entry.prs.push(pr.num);
            }
        }
    }
    // In the order the file reads now; removed sections last, in the order they were found.
    let pos = |t: &str| cur_heads.iter().position(|h| h.title == t).unwrap_or(usize::MAX);
    let mut out: Vec<Section> = seen_order.into_iter().filter_map(|t| found.remove(&t)).collect();
    out.sort_by_key(|sec| pos(&sec.title));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SPEC: &str = "# Spec\n\n## 1. Product\n\nIt's good.\n\n## 3. UX\n\nIntro.\n\n### 3.1 Cards\n\nCards are round.\n\n```\n## not a heading\n```\n\n### 3.2 Links\n\nLinks work.\n";

    #[test]
    fn headings_skip_fenced_code() {
        let h = headings(SPEC);
        let titles: Vec<&str> = h.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, ["Spec", "1. Product", "3. UX", "3.1 Cards", "3.2 Links"]);
        assert_eq!(h[3].line, 11);
    }

    #[test]
    fn a_patch_names_the_new_lines_it_touches() {
        let patch = "@@ -10,4 +10,5 @@ ## 3. UX\n \n ### 3.1 Cards\n \n-Cards are square.\n+Cards are round.\n+Always.\n@@ -30,2 +31,1 @@\n keep\n-gone\n";
        assert_eq!(changed_lines(patch), [13, 13, 14, 32]);
    }

    #[test]
    fn a_line_belongs_to_its_innermost_section() {
        let h = headings(SPEC);
        assert_eq!(section_at(&h, 13).unwrap().title, "3.1 Cards");
        assert_eq!(section_at(&h, 9).unwrap().title, "3. UX");
        assert!(section_at(&h, 1).is_none());
        assert_eq!(section_text(SPEC, &h, "3. UX").unwrap(), "## 3. UX\n\nIntro.");
    }

    #[test]
    fn link_references_are_collected_outside_fences() {
        let t = "Text [a][x].\n\n```\n[y]: no\n```\n\n[x]: https://e.com/x\n[^1]: a footnote\n";
        assert_eq!(link_refs(t), "[x]: https://e.com/x");
    }

    #[test]
    fn slices_cite_sections_by_number() {
        assert_eq!(
            section_refs("Per SPEC §3.11 and § 7; see §3.11 again, and §3.3."),
            ["3.11", "7", "3.3"]
        );
        assert_eq!(section_number("3.11 Shared-in links").as_deref(), Some("3.11"));
        assert_eq!(section_number("4. Accounts and access").as_deref(), Some("4"));
        assert_eq!(section_number("Sharing"), None);
    }

    #[test]
    fn anchors_follow_github() {
        assert_eq!(anchor("3.11 Shared-in links"), "311-shared-in-links");
        assert_eq!(anchor("7. Data model (sketch)"), "7-data-model-sketch");
    }

    #[test]
    fn sections_compare_the_merge_with_now() {
        let pr = SpecPr {
            num: 5,
            title: "t".into(),
            url: "u".into(),
            merged_at: "m".into(),
            code: false,
            sha: "abc".into(),
            files: vec!["SPEC.md".into()],
        };
        let patch = "@@ -12,1 +12,1 @@\n-Cards are square.\n+Cards are round.\n".to_string();
        let now = SPEC.replace("Cards are round.", "Cards are round and blue.");
        let out = sections(
            "o/r",
            "SPEC.md",
            Some(&now),
            &[(&pr, Some(patch), Some(SPEC.to_string()))],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "3.1 Cards");
        assert!(out[0].changed_since);
        assert!(out[0].text.contains("blue"));
        assert_eq!(out[0].merged_url, "https://github.com/o/r/blob/abc/SPEC.md#31-cards");
        let gone = sections(
            "o/r",
            "SPEC.md",
            Some("# Spec\n"),
            &[(&pr, Some("@@ -12,1 +12,1 @@\n+x\n".into()), Some(SPEC.to_string()))],
        );
        assert!(gone[0].removed);
    }

    #[test]
    fn provenance_finds_spec_prs_slices_and_checks() {
        let pr = |n: u32, files: &[&str]| {
            json!({"__typename": "PullRequest", "number": n, "title": "p", "url": "u", "merged": true,
            "mergedAt": "2026-10-24", "mergeCommit": {"oid": format!("sha{n}")}, "files": {"nodes": files.iter().map(|f| json!({"path": f})).collect::<Vec<_>>()}})
        };
        let check = json!({"__typename": "Issue", "number": 90, "title": "Check: x", "url": "c", "state": "OPEN", "labels": {"nodes": [{"name": "check:owner"}]}});
        let mut late = pr(22, &["SPEC.md"]);
        late["mergedAt"] = json!("2026-11-02");
        let v = json!({"data": {"repository": {"defaultBranchRef": {"name": "main"}, "issue": {
        "createdAt": "a", "closedAt": "2026-10-30T00:00:00Z", "timelineItems": {"nodes": []},
        "subIssues": {"nodes": [
            {"number": 10, "title": "Fold it", "url": "u10", "state": "CLOSED", "labels": {"nodes": [{"name": "wayfinder:task"}]},
             "timelineItems": {"nodes": [{"source": pr(20, &["SPEC.md", "x.ts"])}, {"source": pr(21, &["x.ts"])}, {"source": late}]},
             "subIssues": {"nodes": [{"number": 30, "title": "Slice", "url": "u30", "state": "OPEN", "body": "Builds SPEC §3.11.", "labels": {"nodes": [{"name": "size:m"}]},
                "timelineItems": {"nodes": [{"source": check}]}}]}},
            {"number": 11, "title": "Built", "url": "u11", "state": "CLOSED", "stateReason": "NOT_PLANNED", "labels": {"nodes": [{"name": "ready-for-agent"}]},
             "timelineItems": {"nodes": []}, "subIssues": {"nodes": []}}
        ]}}}}});
        let p = parse(&v, &["SPEC.md", "CONTEXT.md"]).unwrap();
        // 21 touches no spec file; 22 merged after the map closed.
        assert_eq!(p.prs.iter().map(|x| x.num).collect::<Vec<_>>(), [20]);
        assert_eq!(p.prs[0].files, ["SPEC.md"]);
        assert!(p.prs[0].code, "x.ts came with it");
        assert_eq!(
            p.slices.iter().map(|x| (x.num, x.open)).collect::<Vec<_>>(),
            [(11, false), (30, true)]
        );
        assert_eq!(p.slices[1].refs, ["3.11"]);
        assert!(p.slices[0].dropped && !p.slices[1].dropped);
        assert_eq!(p.checks.len(), 1);
        assert_eq!(p.checks[0].kind, "owner");
        assert_eq!(p.closed_at.as_deref(), Some("2026-10-30T00:00:00Z"));
    }
}
