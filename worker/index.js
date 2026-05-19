// ─── Security headers added to every JSON response ───────────────────────────
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "no-referrer"
};

const BASE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  ...SECURITY_HEADERS
};

const EXPIRATION_TTLS = Object.freeze({
  "5min":  5 * 60,
  "1hr":   60 * 60,
  "1day":  24 * 60 * 60,
  "1week": 7 * 24 * 60 * 60,
  "never": null
});

const ALLOWED_FORMATTERS = new Set(["plain", "code", "markdown"]);

// Max size for inline base64 attachments kept inside KV payload (50 KB encoded).
// Anything larger must be uploaded via the dedicated /api/paste/:id/attachment endpoint.
const INLINE_ATTACHMENT_LIMIT = 50 * 1024;

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = buildCorsHeaders(env, origin);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) {
        return jsonResponse({ error: "Not found" }, 404, corsHeaders);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (await enforceRateLimit(env, ip)) {
        return jsonResponse({ error: "Too many requests. Limit is 10 per minute." }, 429, corsHeaders);
      }

      const seg = url.pathname.split("/").filter(Boolean);
      // seg[0] === "api"

      // POST /api/paste
      if (seg.length === 2 && seg[1] === "paste" && request.method === "POST") {
        return createPaste(request, env, corsHeaders);
      }

      // GET|DELETE /api/paste/:id
      if (seg.length === 3 && seg[1] === "paste") {
        const id = seg[2];
        if (request.method === "GET")    return getPaste(id, env, ctx, corsHeaders);
        if (request.method === "DELETE") return deletePaste(id, request, env, corsHeaders);
      }

      // PUT /api/paste/:id/attachment  — upload raw encrypted binary to R2
      if (seg.length === 4 && seg[1] === "paste" && seg[3] === "attachment") {
        const id = seg[2];
        if (request.method === "PUT") return uploadAttachment(id, request, env, corsHeaders);
        if (request.method === "GET") return downloadAttachment(id, request, env, corsHeaders);
      }

      // POST /api/paste/:id/comment
      if (seg.length === 4 && seg[1] === "paste" && seg[3] === "comment" && request.method === "POST") {
        return addComment(seg[2], request, env, corsHeaders);
      }

      // GET /api/paste/:id/comments
      if (seg.length === 4 && seg[1] === "paste" && seg[3] === "comments" && request.method === "GET") {
        return getComments(seg[2], env, corsHeaders);
      }

      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: "Internal server error", detail: err.message }, 500, corsHeaders);
    }
  }
};

// ─── CORS ─────────────────────────────────────────────────────────────────────
function buildCorsHeaders(env, origin) {
  let allowedOrigins = [];
  try {
    allowedOrigins = JSON.parse(env.ALLOWED_ORIGINS || "[]");
  } catch {
    allowedOrigins = [];
  }

  const allowOrigin = allowedOrigins.includes(origin)
    ? origin
    : (allowedOrigins[0] || "*");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Delete-Token, X-Attachment-Meta",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

// ─── POST /api/paste ──────────────────────────────────────────────────────────
async function createPaste(request, env, corsHeaders) {
  const body = await safeJson(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  if (!body.ciphertext || !body.iv) {
    return jsonResponse({ error: "Missing ciphertext or iv" }, 400, corsHeaders);
  }

  const expiration = typeof body.expiration === "string" ? body.expiration : "1day";
  if (!Object.prototype.hasOwnProperty.call(EXPIRATION_TTLS, expiration)) {
    return jsonResponse({ error: "Invalid expiration value" }, 400, corsHeaders);
  }

  // Guard against oversized inline attachments being smuggled in the paste payload
  const ciphertextLen = String(body.ciphertext).length;
  if (ciphertextLen > INLINE_ATTACHMENT_LIMIT * 4) {
    return jsonResponse({
      error: "Paste payload too large. Upload the attachment via PUT /api/paste/:id/attachment first."
    }, 413, corsHeaders);
  }

  const formatter      = ALLOWED_FORMATTERS.has(body.formatter) ? body.formatter : "plain";
  const burnAfterRead  = Boolean(body.burnAfterReading);
  const openDiscussion = Boolean(body.openDiscussion);

  const id              = generateId();
  const deleteToken     = generateToken(24);
  const deleteTokenHash = await sha256Hex(deleteToken);
  const ttl             = EXPIRATION_TTLS[expiration];
  const now             = Date.now();

  const record = {
    id,
    version: 2,
    createdAt:       new Date(now).toISOString(),
    expiresAt:       ttl ? new Date(now + ttl * 1000).toISOString() : null,
    burnAfterReading: burnAfterRead,
    openDiscussion,
    formatter,
    payload: {
      iv:         String(body.iv),
      ciphertext: String(body.ciphertext)
    },
    // R2 attachment reference — populated by uploadAttachment after paste creation
    attachmentKey: null,
    // Client-supplied metadata (name, type, size) stored here; content lives in R2
    attachmentMeta: null,
    deleteTokenHash
  };

  const kvOpts = ttl ? { expirationTtl: ttl } : undefined;
  await env.PASTES.put(pasteKey(id), JSON.stringify(record), kvOpts);
  if (openDiscussion) {
    await env.PASTES.put(commentsKey(id), JSON.stringify([]), kvOpts);
  }

  return jsonResponse({
    id,
    deleteToken,
    expiresAt: record.expiresAt,
    burnAfterReading: burnAfterRead,
    openDiscussion
  }, 201, corsHeaders);
}

// ─── GET /api/paste/:id ───────────────────────────────────────────────────────
async function getPaste(id, env, ctx, corsHeaders) {
  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const record = JSON.parse(raw);

  if (record.burnAfterReading) {
    const cleanups = [
      env.PASTES.delete(pasteKey(id)),
      env.PASTES.delete(commentsKey(id))
    ];
    if (record.attachmentKey && env.ATTACHMENTS) {
      cleanups.push(env.ATTACHMENTS.delete(record.attachmentKey));
    }
    ctx.waitUntil(Promise.all(cleanups));
  }

  return jsonResponse({
    id:              record.id,
    version:         record.version,
    createdAt:       record.createdAt,
    expiresAt:       record.expiresAt,
    burnAfterReading: record.burnAfterReading,
    openDiscussion:  record.openDiscussion,
    formatter:       record.formatter,
    payload:         record.payload,
    // Tell the client whether an R2 attachment exists and its public metadata
    hasAttachment:   Boolean(record.attachmentKey),
    attachmentMeta:  record.attachmentMeta || null
  }, 200, corsHeaders);
}

// ─── DELETE /api/paste/:id ────────────────────────────────────────────────────
async function deletePaste(id, request, env, corsHeaders) {
  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const token = request.headers.get("X-Delete-Token") || new URL(request.url).searchParams.get("token");
  if (!token) return jsonResponse({ error: "Delete token required" }, 401, corsHeaders);

  const record = JSON.parse(raw);
  if (await sha256Hex(token) !== record.deleteTokenHash) {
    return jsonResponse({ error: "Invalid delete token" }, 403, corsHeaders);
  }

  const deletes = [
    env.PASTES.delete(pasteKey(id)),
    env.PASTES.delete(commentsKey(id))
  ];
  if (record.attachmentKey && env.ATTACHMENTS) {
    deletes.push(env.ATTACHMENTS.delete(record.attachmentKey));
  }
  await Promise.all(deletes);

  return jsonResponse({ deleted: true }, 200, corsHeaders);
}

// ─── PUT /api/paste/:id/attachment ───────────────────────────────────────────
// Client streams the raw AES-GCM encrypted binary (ArrayBuffer) here.
// X-Attachment-Meta header must be a JSON string: { name, type, size, iv }
// The IV used to encrypt the attachment can be different from the paste IV.
async function uploadAttachment(id, request, env, corsHeaders) {
  if (!env.ATTACHMENTS) {
    return jsonResponse({ error: "R2 attachment storage is not configured." }, 503, corsHeaders);
  }

  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const record = JSON.parse(raw);

  // Parse client-supplied metadata from request header
  let meta;
  try {
    meta = JSON.parse(request.headers.get("X-Attachment-Meta") || "null");
    if (!meta || !meta.name || !meta.iv) throw new Error("bad meta");
  } catch {
    return jsonResponse({
      error: "X-Attachment-Meta header must be JSON with at minimum: { name, type, size, iv }"
    }, 400, corsHeaders);
  }

  // Sanitize meta fields — only safe scalar values stored in KV
  const safeMeta = {
    name: String(meta.name).slice(0, 260),
    type: String(meta.type || "application/octet-stream").slice(0, 128),
    size: Number(meta.size) || 0,
    iv:   String(meta.iv).slice(0, 64)
  };

  // Stream the encrypted body directly into R2 — no buffering in worker memory
  const r2Key = attachmentKey(id);
  await env.ATTACHMENTS.put(r2Key, request.body, {
    httpMetadata: {
      contentType: "application/octet-stream"   // always binary; decrypted client-side
    },
    customMetadata: {
      pasteId: id,
      originalName: safeMeta.name,
      iv: safeMeta.iv
    }
  });

  // Update the KV record to reference the R2 key
  record.attachmentKey  = r2Key;
  record.attachmentMeta = safeMeta;

  const ttlMs = record.expiresAt ? new Date(record.expiresAt).getTime() - Date.now() : null;
  const kvOpts = ttlMs && ttlMs > 0 ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined;
  await env.PASTES.put(pasteKey(id), JSON.stringify(record), kvOpts);

  return jsonResponse({ ok: true, key: r2Key, meta: safeMeta }, 200, corsHeaders);
}

// ─── GET /api/paste/:id/attachment ───────────────────────────────────────────
// Streams the raw encrypted binary back to the client.
// The client decrypts it with the master key from the URL fragment.
async function downloadAttachment(id, request, env, corsHeaders) {
  if (!env.ATTACHMENTS) {
    return jsonResponse({ error: "R2 attachment storage is not configured." }, 503, corsHeaders);
  }

  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const record = JSON.parse(raw);
  if (!record.attachmentKey) {
    return jsonResponse({ error: "This paste has no attachment." }, 404, corsHeaders);
  }

  const obj = await env.ATTACHMENTS.get(record.attachmentKey);
  if (!obj) {
    return jsonResponse({ error: "Attachment not found in storage." }, 404, corsHeaders);
  }

  const responseHeaders = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="encrypted.bin"`,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...corsHeaders
  };

  // Stream directly — no buffering
  return new Response(obj.body, { status: 200, headers: responseHeaders });
}

// ─── POST /api/paste/:id/comment ─────────────────────────────────────────────
async function addComment(id, request, env, corsHeaders) {
  const pasteRaw = await env.PASTES.get(pasteKey(id));
  if (!pasteRaw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const paste = JSON.parse(pasteRaw);
  if (!paste.openDiscussion) {
    return jsonResponse({ error: "Discussion is disabled for this paste" }, 403, corsHeaders);
  }

  const body = await safeJson(request);
  if (!body || !body.ciphertext || !body.iv) {
    return jsonResponse({ error: "Missing ciphertext or iv" }, 400, corsHeaders);
  }

  const rawComments = await env.PASTES.get(commentsKey(id));
  const comments = rawComments ? JSON.parse(rawComments) : [];
  comments.push({
    id:        generateId(),
    createdAt: new Date().toISOString(),
    iv:        String(body.iv),
    ciphertext: String(body.ciphertext)
  });

  await env.PASTES.put(commentsKey(id), JSON.stringify(comments), ttlFromExpiry(paste.expiresAt));
  return jsonResponse({ ok: true, count: comments.length }, 201, corsHeaders);
}

// ─── GET /api/paste/:id/comments ─────────────────────────────────────────────
async function getComments(id, env, corsHeaders) {
  const pasteRaw = await env.PASTES.get(pasteKey(id));
  if (!pasteRaw) return jsonResponse({ error: "Paste not found" }, 404, corsHeaders);

  const paste = JSON.parse(pasteRaw);
  if (!paste.openDiscussion) return jsonResponse({ comments: [] }, 200, corsHeaders);

  const rawComments = await env.PASTES.get(commentsKey(id));
  return jsonResponse({ comments: rawComments ? JSON.parse(rawComments) : [] }, 200, corsHeaders);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
async function enforceRateLimit(env, ip) {
  if (!env.RATE_LIMITS) return false;

  const salt      = env.RATE_LIMIT_SALT || "codexbin_default_ratelimit_salt_2026";
  const hashedIp  = await sha256Hex(`${ip}:${salt}`);
  const bucket    = Math.floor(Date.now() / 60_000);
  const key       = `ratelimit:${hashedIp}:${bucket}`;
  const current   = Number(await env.RATE_LIMITS.get(key) || "0");

  if (current >= 10) return true;

  await env.RATE_LIMITS.put(key, String(current + 1), { expirationTtl: 65 });
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function sha256Hex(value) {
  const bytes  = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function generateToken(byteLen = 16) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function pasteKey(id)      { return `paste:${id}`; }
function commentsKey(id)   { return `comments:${id}`; }
function attachmentKey(id) { return `attachments/${id}/blob`; }

function ttlFromExpiry(expiresAt) {
  if (!expiresAt) return undefined;
  const ms  = new Date(expiresAt).getTime() - Date.now();
  const ttl = Math.max(1, Math.ceil(ms / 1000));
  return { expirationTtl: ttl };
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_JSON_HEADERS, ...corsHeaders }
  });
}
