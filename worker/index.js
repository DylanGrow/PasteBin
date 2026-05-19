const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Delete-Token",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  ...CORS_HEADERS
};

const EXPIRATION_TTLS = Object.freeze({
  "5min": 5 * 60,
  "1hr": 60 * 60,
  "1day": 24 * 60 * 60,
  "1week": 7 * 24 * 60 * 60,
  "never": null
});

const ALLOWED_FORMATTERS = new Set(["plain", "code", "markdown"]);

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) {
        return json({ error: "Not found" }, 404);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const isRateLimited = await enforceRateLimit(env, ip);
      if (isRateLimited) {
        return json({ error: "Too many requests. Limit is 10 requests per minute." }, 429);
      }

      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 2 && segments[0] === "api" && segments[1] === "paste" && request.method === "POST") {
        return createPaste(request, env);
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "paste") {
        const id = segments[2];
        if (request.method === "GET") {
          return getPaste(id, env, ctx);
        }
        if (request.method === "DELETE") {
          return deletePaste(id, request, env);
        }
      }

      if (segments.length === 4 && segments[0] === "api" && segments[1] === "paste" && segments[3] === "comment") {
        const id = segments[2];
        if (request.method === "POST") {
          return addComment(id, request, env);
        }
      }

      if (segments.length === 4 && segments[0] === "api" && segments[1] === "paste" && segments[3] === "comments") {
        const id = segments[2];
        if (request.method === "GET") {
          return getComments(id, env);
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: "Internal server error", detail: error.message }, 500);
    }
  }
};

async function createPaste(request, env) {
  const body = await safeJson(request);
  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.ciphertext || !body.iv) {
    return json({ error: "Missing required encrypted payload fields" }, 400);
  }

  const expiration = typeof body.expiration === "string" ? body.expiration : "1day";
  if (!Object.prototype.hasOwnProperty.call(EXPIRATION_TTLS, expiration)) {
    return json({ error: "Invalid expiration value" }, 400);
  }

  const formatter = ALLOWED_FORMATTERS.has(body.formatter) ? body.formatter : "plain";
  const burnAfterReading = Boolean(body.burnAfterReading);
  const openDiscussion = Boolean(body.openDiscussion);

  const id = generateId();
  const deleteToken = generateToken(24);
  const deleteTokenHash = await sha256Hex(deleteToken);
  const ttl = EXPIRATION_TTLS[expiration];
  const now = Date.now();

  const pasteRecord = {
    id,
    version: 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: ttl ? new Date(now + ttl * 1000).toISOString() : null,
    burnAfterReading,
    openDiscussion,
    formatter,
    payload: {
      iv: String(body.iv),
      ciphertext: String(body.ciphertext)
    },
    deleteTokenHash
  };

  await env.PASTES.put(pasteKey(id), JSON.stringify(pasteRecord), ttl ? { expirationTtl: ttl } : undefined);

  if (openDiscussion) {
    await env.PASTES.put(commentsKey(id), JSON.stringify([]), ttl ? { expirationTtl: ttl } : undefined);
  }

  return json({
    id,
    deleteToken,
    expiresAt: pasteRecord.expiresAt,
    burnAfterReading,
    openDiscussion
  }, 201);
}

async function getPaste(id, env, ctx) {
  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) {
    return json({ error: "Paste not found" }, 404);
  }

  const record = JSON.parse(raw);

  if (record.burnAfterReading) {
    ctx.waitUntil(Promise.all([
      env.PASTES.delete(pasteKey(id)),
      env.PASTES.delete(commentsKey(id))
    ]));
  }

  return json({
    id: record.id,
    version: record.version,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    burnAfterReading: record.burnAfterReading,
    openDiscussion: record.openDiscussion,
    formatter: record.formatter,
    payload: record.payload
  });
}

async function deletePaste(id, request, env) {
  const raw = await env.PASTES.get(pasteKey(id));
  if (!raw) {
    return json({ error: "Paste not found" }, 404);
  }

  const token = request.headers.get("X-Delete-Token") || new URL(request.url).searchParams.get("token");
  if (!token) {
    return json({ error: "Delete token required" }, 401);
  }

  const record = JSON.parse(raw);
  const tokenHash = await sha256Hex(token);
  if (tokenHash !== record.deleteTokenHash) {
    return json({ error: "Invalid delete token" }, 403);
  }

  await Promise.all([
    env.PASTES.delete(pasteKey(id)),
    env.PASTES.delete(commentsKey(id))
  ]);

  return json({ deleted: true });
}

async function addComment(id, request, env) {
  const pasteRaw = await env.PASTES.get(pasteKey(id));
  if (!pasteRaw) {
    return json({ error: "Paste not found" }, 404);
  }

  const paste = JSON.parse(pasteRaw);
  if (!paste.openDiscussion) {
    return json({ error: "Discussion is disabled for this paste" }, 403);
  }

  const body = await safeJson(request);
  if (!body || !body.ciphertext || !body.iv) {
    return json({ error: "Missing required encrypted comment fields" }, 400);
  }

  const rawComments = await env.PASTES.get(commentsKey(id));
  const comments = rawComments ? JSON.parse(rawComments) : [];
  comments.push({
    id: generateId(),
    createdAt: new Date().toISOString(),
    iv: String(body.iv),
    ciphertext: String(body.ciphertext)
  });

  await env.PASTES.put(commentsKey(id), JSON.stringify(comments), ttlOptionsFromPasteExpiry(paste.expiresAt));

  return json({ ok: true, count: comments.length }, 201);
}

async function getComments(id, env) {
  const pasteRaw = await env.PASTES.get(pasteKey(id));
  if (!pasteRaw) {
    return json({ error: "Paste not found" }, 404);
  }

  const paste = JSON.parse(pasteRaw);
  if (!paste.openDiscussion) {
    return json({ comments: [] });
  }

  const rawComments = await env.PASTES.get(commentsKey(id));
  const comments = rawComments ? JSON.parse(rawComments) : [];
  return json({ comments });
}

async function enforceRateLimit(env, ip) {
  if (!env.RATE_LIMITS) {
    return false;
  }

  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${ip}:${minuteBucket}`;
  const current = Number(await env.RATE_LIMITS.get(key) || "0");

  if (current >= 10) {
    return true;
  }

  await env.RATE_LIMITS.put(key, String(current + 1), { expirationTtl: 65 });
  return false;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function generateToken(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pasteKey(id) {
  return `paste:${id}`;
}

function commentsKey(id) {
  return `comments:${id}`;
}

function ttlOptionsFromPasteExpiry(expiresAt) {
  if (!expiresAt) {
    return undefined;
  }

  const msRemaining = new Date(expiresAt).getTime() - Date.now();
  const ttl = Math.max(1, Math.ceil(msRemaining / 1000));
  return { expirationTtl: ttl };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}
