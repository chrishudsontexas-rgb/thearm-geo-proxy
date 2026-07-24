// GEO Scorecard fetch proxy
// Serves /api/proxy?url=<encoded target> for the scorecard's second fetch route.
// Fetches server-side with a normal browser user agent, which passes the CDN
// bot filters that block public CORS proxies. Returns the upstream body with
// the upstream HTTP status in the x-upstream-status header.

const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/i;

export default async (req) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*"
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });

  let target;
  try {
    const raw = new URL(req.url).searchParams.get("url") || "";
    target = new URL(raw);
    if (!/^https?:$/.test(target.protocol)) throw new Error("bad protocol");
    if (BLOCKED_HOST.test(target.hostname)) throw new Error("blocked host");
  } catch (e) {
    return new Response("Invalid url parameter", { status: 400, headers: cors });
  }

  try {
    const upstream = await fetch(target.href, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    const text = await upstream.text();
    return new Response(text, {
      status: 200,
      headers: {
        ...cors,
        "x-upstream-status": String(upstream.status),
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (e) {
    return new Response("", {
      status: 200,
      headers: { ...cors, "x-upstream-status": "0", "content-type": "text/plain; charset=utf-8" }
    });
  }
};

export const config = { path: "/api/proxy" };
