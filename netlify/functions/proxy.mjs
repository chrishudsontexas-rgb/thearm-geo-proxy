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

  const CHALLENGE = /just a moment|checking your browser|challenge-platform|_cf_chl|cf-turnstile|attention required/i;
  const scraperKey = ((typeof process !== "undefined" && process.env && process.env.SCRAPER_API_KEY) || "").trim();
  const wantDebug = new URL(req.url).searchParams.get("debug") === "1";
  const forceScraper = new URL(req.url).searchParams.get("force_scraper") === "1";
  let scraperState = scraperKey ? "key-present, not attempted" : "no-key";

  const reply = (text, upStatus, route) => {
    if (wantDebug) {
      return new Response(JSON.stringify({
        target: target.href,
        attempt1_upstream_status: upStatus,
        key_present: !!scraperKey,
        scraper: scraperState,
        served_route: route || "direct",
        body_chars: (text || "").length
      }, null, 2), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    }
    return new Response(text, {
      status: 200,
      headers: {
        ...cors,
        "x-upstream-status": String(upStatus),
        "x-proxy-route": route || "direct",
        "x-scraper": scraperState,
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  };

  // Attempt 1: direct server-side fetch with browser headers
  let text = "", upStatus = 0;
  if (!forceScraper) try {
    const upstream = await fetch(target.href, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    text = await upstream.text();
    upStatus = upstream.status;
  } catch (e) { text = ""; upStatus = 0; }

  const blocked = forceScraper || upStatus === 0 || upStatus >= 400 || CHALLENGE.test(text || "");
  if (!blocked) return reply(text, upStatus);

  // Attempt 2 (optional): escalate through ScraperAPI when a key is configured.
  // Free key from scraperapi.com; set SCRAPER_API_KEY in this site's Netlify environment variables.
  if (scraperKey) {
    const attempts = [
      { label: "standard", extra: "", timeout: 8000 },
      { label: "premium", extra: "&premium=true", timeout: 20000 }
    ];
    for (const a of attempts) {
      try {
        const s = await fetch("https://api.scraperapi.com/?api_key=" + encodeURIComponent(scraperKey) + "&url=" + encodeURIComponent(target.href) + a.extra, {
          signal: AbortSignal.timeout(a.timeout)
        });
        const st = await s.text();
        if (s.ok && st && !CHALLENGE.test(st)) { scraperState = a.label + " ok, " + st.length + " chars"; return reply(st, 200, "anti-bot"); }
        scraperState = a.label + " " + (s.ok ? (CHALLENGE.test(st) ? "returned challenge page" : "empty body") : "HTTP " + s.status + (st ? ": " + st.slice(0, 100).replace(/\s+/g, " ") : ""));
      } catch (e) { scraperState = a.label + " " + (e && e.name === "TimeoutError" ? "timed out" : "fetch error"); }
    }
  }

  // Report honestly: pass through what the direct attempt saw
  return reply(text || "", upStatus);
};

export const config = { path: "/api/proxy" };
