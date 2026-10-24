import type { NextConfig } from "next";

// The build is a static export that the Rust server embeds and serves next to /api. Static
// exports can't rewrite, so only `next dev` proxies /api to a running server. The proxy sends
// the server's own Host, but a launch carries the browser's Origin, so start the server with
// --allow-host localhost:3000 to launch from the dev page.
const api = process.env.CONSOLE_API ?? "http://127.0.0.1:7788";

const nextConfig: NextConfig =
  process.env.NODE_ENV === "development"
    ? { rewrites: async () => [{ source: "/api/:path*", destination: `${api}/api/:path*` }] }
    : { output: "export" };

export default nextConfig;
