interface Env {
  DB: D1Database;
  LICENSE_SIGNING_SECRET: string;
  LICENSE_TOKEN_TTL_SECONDS?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const data = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
  return `${data}.${encoded}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,OPTIONS" } });
    const url = new URL(request.url);
    if (url.pathname !== "/v1/license/activate" || request.method !== "POST") return json({ error: "not_found" }, 404);
    try {
      const input = (await request.json()) as { licenseKey?: string; deviceId?: string };
      if (!input.licenseKey || !input.deviceId) return json({ error: "licenseKey_and_deviceId_required" }, 400);
      const licenseHash = await hash(input.licenseKey.trim());
      const deviceHash = await hash(input.deviceId);
      const license = await env.DB.prepare("SELECT * FROM licenses WHERE license_key_hash = ? AND status = 'active'").bind(licenseHash).first<any>();
      if (!license || (license.expires_at && Date.parse(license.expires_at) < Date.now())) return json({ error: "invalid_or_expired_license" }, 403);
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE license_id = ?").bind(license.id).first<any>();
      const existing = await env.DB.prepare("SELECT id FROM devices WHERE license_id = ? AND device_hash = ?").bind(license.id, deviceHash).first();
      if (!existing && Number(count?.count ?? 0) >= license.max_devices) return json({ error: "device_limit_reached" }, 403);
      await env.DB.prepare("INSERT OR IGNORE INTO devices (id, license_id, device_hash) VALUES (?, ?, ?)").bind(crypto.randomUUID(), license.id, deviceHash).run();
      await env.DB.prepare("UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP WHERE license_id = ? AND device_hash = ?").bind(license.id, deviceHash).run();
      const exp = Math.floor(Date.now() / 1000) + Number(env.LICENSE_TOKEN_TTL_SECONDS ?? 86400);
      return json({ token: await sign({ licenseId: license.id, deviceHash, exp }, env.LICENSE_SIGNING_SECRET), expiresAt: new Date(exp * 1000).toISOString() });
    } catch { return json({ error: "invalid_request" }, 400); }
  },
};
