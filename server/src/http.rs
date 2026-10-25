//! Starchart's HTTP API and the embedded web app.
//!
//! The server binds to loopback, but any web page the user opens can still send requests to
//! loopback, and a launch starts an agent on this machine. So every request must carry an
//! allowed Host (which defeats DNS rebinding), and every write must also carry the per-run
//! token from `GET /api/session` (which another origin can't read, since no CORS headers are
//! sent) and, when the browser sends one, an Origin with an allowed host.

use crate::github::GitHub;
use crate::model::Map;
use crate::t3::{self, LaunchRequest, T3};
use axum::extract::{Path, Query, Request, State};
use axum::http::{Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::Embed;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Embed)]
#[folder = "../web/out"]
struct Assets;

#[derive(Clone, Debug)]
pub struct Project {
    pub repo: String,
    pub path: String,
}

pub struct App {
    pub projects: Vec<Project>,
    pub token: String,
    pub allowed_hosts: Vec<String>,
    pub github: GitHub,
    pub t3: T3,
    cache: Mutex<HashMap<(String, u32), (Instant, Map)>>,
}

const MAP_TTL: Duration = Duration::from_secs(30);

impl App {
    pub fn new(projects: Vec<Project>, token: String, allowed_hosts: Vec<String>, github: GitHub, t3: T3) -> Self {
        App {
            projects,
            token,
            allowed_hosts,
            github,
            t3,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn project(&self, repo: &str) -> Result<&Project, ApiError> {
        self.projects
            .iter()
            .find(|p| p.repo == repo)
            .ok_or_else(|| ApiError::bad(format!("{repo} isn't a configured project")))
    }

    async fn map(&self, repo: &str, num: u32, fresh: bool) -> Result<Map, ApiError> {
        let key = (repo.to_string(), num);
        if !fresh
            && let Some((at, m)) = self.cache.lock().await.get(&key)
            && at.elapsed() < MAP_TTL
        {
            return Ok(m.clone());
        }
        let m = self.github.map(repo, num).await.map_err(ApiError::upstream)?;
        self.cache.lock().await.insert(key, (Instant::now(), m.clone()));
        Ok(m)
    }
}

pub struct ApiError(StatusCode, String);

impl ApiError {
    fn bad(msg: impl Into<String>) -> Self {
        ApiError(StatusCode::BAD_REQUEST, msg.into())
    }
    fn upstream(e: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_GATEWAY, format!("{e:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type Shared = Arc<App>;

pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/api/session", get(session))
        .route("/api/maps", get(maps))
        .route("/api/maps/{num}", get(map))
        .route("/api/threads", get(threads))
        .route("/api/launch", post(launch))
        .fallback(asset)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

fn host_of_origin(origin: &str) -> &str {
    origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin)
        .trim_end_matches('/')
}

async fn guard(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default();
    if !app.allowed_hosts.iter().any(|a| a == host) {
        return ApiError(StatusCode::FORBIDDEN, format!("host {host:?} isn't allowed")).into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let token = headers
            .get("x-starchart-token")
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default();
        if token != app.token {
            return ApiError(StatusCode::FORBIDDEN, "missing or wrong starchart token".into()).into_response();
        }
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok())
            && !app.allowed_hosts.iter().any(|a| a == host_of_origin(origin))
        {
            return ApiError(StatusCode::FORBIDDEN, format!("origin {origin:?} isn't allowed")).into_response();
        }
    }
    next.run(req).await
}

async fn session(State(app): State<Shared>) -> Json<Value> {
    let projects: Vec<Value> = app
        .projects
        .iter()
        .map(|p| json!({ "repo": p.repo, "path": p.path }))
        .collect();
    Json(json!({ "token": app.token, "projects": projects, "t3Environment": crate::t3::environment_id() }))
}

#[derive(Deserialize)]
struct RepoQuery {
    repo: String,
    #[serde(default)]
    fresh: Option<String>,
}

async fn maps(State(app): State<Shared>, Query(q): Query<RepoQuery>) -> Result<Json<Value>, ApiError> {
    app.project(&q.repo)?;
    let list = app.github.maps(&q.repo).await.map_err(ApiError::upstream)?;
    Ok(Json(json!(list)))
}

async fn map(
    State(app): State<Shared>,
    Path(num): Path<u32>,
    Query(q): Query<RepoQuery>,
) -> Result<Json<Map>, ApiError> {
    app.project(&q.repo)?;
    Ok(Json(app.map(&q.repo, num, q.fresh.is_some()).await?))
}

async fn threads(State(app): State<Shared>, Query(q): Query<RepoQuery>) -> Result<Json<Value>, ApiError> {
    let p = app.project(&q.repo)?;
    let list = app.t3.threads(&p.path).await.map_err(ApiError::upstream)?;
    Ok(Json(json!(list)))
}

async fn launch(State(app): State<Shared>, Json(req): Json<LaunchRequest>) -> Result<Json<Value>, ApiError> {
    let p = app.project(&req.repo)?.clone();
    // A launch reads the map fresh, so it never starts work on a ticket that just closed.
    let map = match req.map {
        Some(n) => Some(app.map(&req.repo, n, true).await?),
        None => None,
    };
    let plan = t3::plan(&req, map.as_ref()).map_err(|e| ApiError::bad(e.to_string()))?;
    let started = app.t3.start(&p.path, &plan).await.map_err(ApiError::upstream)?;
    Ok(Json(
        json!({ "title": plan.title, "branch": plan.branch, "thread": started }),
    ))
}

async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidates = if path.is_empty() {
        vec!["index.html".to_string()]
    } else {
        vec![path.to_string(), format!("{path}.html"), format!("{path}/index.html")]
    };
    for c in candidates.iter().chain(std::iter::once(&"index.html".to_string())) {
        if let Some(f) = Assets::get(c) {
            let mime = mime_guess::from_path(c).first_or_octet_stream();
            return ([(header::CONTENT_TYPE, mime.as_ref())], f.data).into_response();
        }
    }
    (
        StatusCode::NOT_FOUND,
        "The web app isn't built: run `npm run build` in web/.",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        router(Arc::new(App::new(
            vec![Project {
                repo: "o/r".into(),
                path: "/tmp".into(),
            }],
            "tok".into(),
            vec!["127.0.0.1:7788".into(), "localhost:7788".into()],
            GitHub {
                gh: "/nonexistent/gh".into(),
            },
            T3 {
                bin: "/nonexistent/t3".into(),
                worktree_base: "origin/main".into(),
            },
        )))
    }

    async fn call(req: axum::http::Request<Body>) -> (StatusCode, String) {
        let res = app().oneshot(req).await.unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn get_req(host: &str, path: &str) -> axum::http::Request<Body> {
        axum::http::Request::get(path)
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    }

    fn launch_req(token: &str, origin: Option<&str>) -> axum::http::Request<Body> {
        let mut b = axum::http::Request::post("/api/launch")
            .header("host", "127.0.0.1:7788")
            .header("content-type", "application/json")
            .header("x-starchart-token", token);
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(Body::from(r#"{"repo":"o/r","kind":"chart","note":""}"#))
            .unwrap()
    }

    #[tokio::test]
    async fn a_foreign_host_is_refused_even_for_reads() {
        let (s, _) = call(get_req("evil.example:7788", "/api/session")).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, body) = call(get_req("localhost:7788", "/api/session")).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""token":"tok""#));
    }

    #[tokio::test]
    async fn a_launch_needs_the_token_and_an_allowed_origin() {
        assert_eq!(call(launch_req("nope", None)).await.0, StatusCode::FORBIDDEN);
        assert_eq!(
            call(launch_req("tok", Some("https://evil.example"))).await.0,
            StatusCode::FORBIDDEN
        );
        // Past the guard, the empty idea is refused by the plan, before any thread starts.
        let (s, body) = call(launch_req("tok", Some("http://127.0.0.1:7788"))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body}");
        assert!(body.contains("needs the idea"));
    }

    #[tokio::test]
    async fn an_unconfigured_repo_is_refused() {
        let (s, body) = call(get_req("127.0.0.1:7788", "/api/maps?repo=other/repo")).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        assert!(body.contains("isn't a configured project"));
    }
}
