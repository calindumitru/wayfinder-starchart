//! wayfinder-console: a star-map of wayfinder maps kept as GitHub issues, with buttons that
//! start T3 Code sessions on a ticket.

mod github;
mod http;
mod model;
mod t3;

use anyhow::{Result, bail};
use clap::Parser;
use rand::Rng;
use std::sync::Arc;

#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// A project as owner/repo=/path/to/checkout; repeat for several. The path is where T3
    /// starts the session.
    #[arg(long = "project", required = true)]
    projects: Vec<String>,
    #[arg(long, default_value_t = 7788)]
    port: u16,
    /// The gh binary.
    #[arg(long, default_value = "gh")]
    gh: String,
    /// T3 Code's CLI; defaults to `t3` on PATH, then ~/.t3/bin/t3.
    #[arg(long)]
    t3: Option<String>,
    /// What a new worktree is based on.
    #[arg(long, default_value = "origin/main")]
    worktree_base: String,
    /// Another Host to accept, such as the Next dev server's `localhost:3000`.
    #[arg(long = "allow-host")]
    allow_hosts: Vec<String>,
}

fn default_t3() -> String {
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("t3").is_file()))
        .unwrap_or(false);
    if on_path {
        return "t3".into();
    }
    std::env::var("HOME")
        .map(|h| format!("{h}/.t3/bin/t3"))
        .unwrap_or_else(|_| "t3".into())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut projects = Vec::new();
    for p in &args.projects {
        let Some((repo, path)) = p.split_once('=') else {
            bail!("--project takes owner/repo=/path, got {p:?}")
        };
        if !repo.contains('/') {
            bail!("--project's repo must be owner/repo, got {repo:?}");
        }
        projects.push(http::Project {
            repo: repo.into(),
            path: path.into(),
        });
    }
    let token: String = rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    let mut hosts = vec![format!("127.0.0.1:{}", args.port), format!("localhost:{}", args.port)];
    hosts.extend(args.allow_hosts);
    let app = Arc::new(http::App::new(
        projects,
        token,
        hosts,
        github::GitHub { gh: args.gh },
        t3::T3 {
            bin: args.t3.unwrap_or_else(default_t3),
            worktree_base: args.worktree_base,
        },
    ));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await?;
    println!("wayfinder-console: http://127.0.0.1:{}", args.port);
    axum::serve(listener, http::router(app)).await?;
    Ok(())
}
