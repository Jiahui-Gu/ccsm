export function corsPreflight(req: Request, allowedOrigins: string[]): Response {
  const origin = req.headers.get("Origin") ?? "";
  const allow = allowedOrigins.includes(origin) ? origin : "";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export function withSecurityHeaders(res: Response, req: Request, allowedOrigins: string[]): Response {
  const h = new Headers(res.headers);
  const origin = req.headers.get("Origin") ?? "";
  if (allowedOrigins.includes(origin)) h.set("Access-Control-Allow-Origin", origin);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, headers: h });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
