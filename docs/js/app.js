const DEFAULT_API_BASE = "https://your-worker-subdomain.workers.dev";
const THEME_STORAGE_KEY = "codexbin-theme";
const API_BASE_STORAGE_KEY = "codexbin-api-base";

const state = {
  pasteId: null,
  pasteMeta: null,
  masterKey: null,
  decryptedPaste: null,
  deleteToken: null,
  currentShareUrl: "",
  attachmentUrl: null
};

const el = {
  alertHost: document.getElementById("alertHost"),
  pasteText: document.getElementById("pasteText"),
  expiration: document.getElementById("expiration"),
  formatter: document.getElementById("formatter"),
  password: document.getElementById("password"),
  attachment: document.getElementById("attachment"),
  apiBase: document.getElementById("apiBase"),
  burnAfterReading: document.getElementById("burnAfterReading"),
  openDiscussion: document.getElementById("openDiscussion"),
  createBtn: document.getElementById("createBtn"),
  createSpinner: document.getElementById("createSpinner"),
  newBtn: document.getElementById("newBtn"),
  cloneBtn: document.getElementById("cloneBtn"),
  themeToggle: document.getElementById("themeToggle"),
  pasteViewSection: document.getElementById("pasteViewSection"),
  pasteRender: document.getElementById("pasteRender"),
  pasteMeta: document.getElementById("pasteMeta"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  qrBtn: document.getElementById("qrBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  qrHost: document.getElementById("qrHost"),
  attachmentView: document.getElementById("attachmentView"),
  attachmentLink: document.getElementById("attachmentLink"),
  commentsSection: document.getElementById("commentsSection"),
  commentsList: document.getElementById("commentsList"),
  newComment: document.getElementById("newComment"),
  addCommentBtn: document.getElementById("addCommentBtn")
};

let qrCode = null;

document.addEventListener("DOMContentLoaded", () => {
  initializeTheme();
  initializeApiBase();
  wireEvents();
  loadPasteFromUrl();
});

function wireEvents() {
  el.createBtn.addEventListener("click", createPaste);
  el.newBtn.addEventListener("click", prepareNewPaste);
  el.cloneBtn.addEventListener("click", clonePasteToEditor);
  el.themeToggle.addEventListener("click", toggleTheme);
  el.copyLinkBtn.addEventListener("click", copyShareLink);
  el.qrBtn.addEventListener("click", renderQrCode);
  el.deleteBtn.addEventListener("click", deleteCurrentPaste);
  el.addCommentBtn.addEventListener("click", addEncryptedComment);

  el.apiBase.addEventListener("change", () => {
    const normalized = normalizeApiBase(el.apiBase.value);
    el.apiBase.value = normalized;
    if (normalized) {
      localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(API_BASE_STORAGE_KEY);
    }
  });
}

function initializeTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const preferred = savedTheme || "dark";
  setTheme(preferred);
}

function toggleTheme() {
  const current = document.body.getAttribute("data-bs-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
}

function setTheme(theme) {
  document.body.setAttribute("data-bs-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  el.themeToggle.innerHTML = theme === "dark" ? '<i class="bi bi-moon-stars"></i>' : '<i class="bi bi-sun"></i>';
}

function initializeApiBase() {
  const saved = localStorage.getItem(API_BASE_STORAGE_KEY);
  const value = saved || DEFAULT_API_BASE;
  el.apiBase.value = value;
}

function normalizeApiBase(value) {
  return value.trim().replace(/\/+$/, "");
}

function getApiBase() {
  const base = normalizeApiBase(el.apiBase.value);
  if (!base) {
    throw new Error("Set your Worker API base URL first.");
  }
  localStorage.setItem(API_BASE_STORAGE_KEY, base);
  return base;
}

function buildApiUrl(path) {
  return `${getApiBase()}${path}`;
}

async function createPaste() {
  const text = el.pasteText.value;
  const file = el.attachment.files[0];

  if (!text && !file) {
    showAlert("warning", "Provide text or a file attachment before creating a paste.");
    return;
  }

  setCreateLoading(true);

  try {
    const formatter = el.formatter.value;
    const payload = await buildPlainPayload(text, formatter, file);

    const masterKey = await generateMasterKey();
    const encryptedPayload = await encryptJson(payload, masterKey);
    const fragment = await buildFragment(masterKey, el.password.value);

    const body = {
      ciphertext: encryptedPayload.ciphertext,
      iv: encryptedPayload.iv,
      expiration: el.expiration.value,
      burnAfterReading: el.burnAfterReading.checked,
      openDiscussion: el.openDiscussion.checked,
      formatter
    };

    const response = await apiJson("/api/paste", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const shareUrl = `${window.location.origin}${window.location.pathname}?p=${encodeURIComponent(response.id)}#${fragment}`;

    state.pasteId = response.id;
    state.pasteMeta = {
      id: response.id,
      createdAt: new Date().toISOString(),
      expiresAt: response.expiresAt,
      burnAfterReading: response.burnAfterReading,
      openDiscussion: response.openDiscussion,
      formatter
    };
    state.masterKey = masterKey;
    state.decryptedPaste = payload;
    state.currentShareUrl = shareUrl;
    state.deleteToken = response.deleteToken;

    sessionStorage.setItem(`delete-token:${response.id}`, response.deleteToken);
    history.replaceState(null, "", `?p=${encodeURIComponent(response.id)}#${fragment}`);

    renderDecryptedPaste(payload, state.pasteMeta);
    toggleDiscussion(state.pasteMeta.openDiscussion);
    renderComments([]);

    try {
      await navigator.clipboard.writeText(shareUrl);
      showAlert("success", "Paste created. Share link copied to clipboard.");
    } catch {
      showAlert("success", "Paste created. Copy the share URL from your address bar.");
    }
  } catch (error) {
    showAlert("danger", `Failed to create paste: ${error.message}`);
  } finally {
    setCreateLoading(false);
  }
}

async function loadPasteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const pasteId = params.get("p");

  if (!pasteId) {
    return;
  }

  try {
    const response = await apiJson(`/api/paste/${encodeURIComponent(pasteId)}`);
    const key = await resolveKeyFromFragment();
    const plaintext = await decryptToText(response.payload, key);
    const payload = JSON.parse(plaintext);

    state.pasteId = pasteId;
    state.pasteMeta = response;
    state.masterKey = key;
    state.decryptedPaste = payload;
    state.currentShareUrl = window.location.href;
    state.deleteToken = sessionStorage.getItem(`delete-token:${pasteId}`);

    renderDecryptedPaste(payload, response);
    toggleDiscussion(response.openDiscussion);

    if (response.openDiscussion) {
      try {
        await refreshComments();
      } catch {
        renderComments([]);
      }
    }

    showAlert("success", response.burnAfterReading ? "Paste opened. This burn-after-reading paste is now deleted server-side." : "Paste decrypted successfully.", 7000);
  } catch (error) {
    showAlert("danger", `Could not open paste: ${error.message}`);
  }
}

function prepareNewPaste() {
  state.pasteId = null;
  state.pasteMeta = null;
  state.masterKey = null;
  state.decryptedPaste = null;
  state.deleteToken = null;
  state.currentShareUrl = "";

  if (state.attachmentUrl) {
    URL.revokeObjectURL(state.attachmentUrl);
    state.attachmentUrl = null;
  }

  el.pasteText.value = "";
  el.attachment.value = "";
  el.password.value = "";
  el.formatter.value = "plain";
  el.expiration.value = "1day";
  el.burnAfterReading.checked = false;
  el.openDiscussion.checked = true;

  el.pasteViewSection.classList.add("d-none");
  el.commentsSection.classList.add("d-none");
  el.cloneBtn.disabled = true;

  history.replaceState(null, "", window.location.pathname);
  showAlert("info", "Ready for a new paste.", 2500);
}

function clonePasteToEditor() {
  if (!state.decryptedPaste) {
    showAlert("warning", "No decrypted paste to clone yet.");
    return;
  }

  el.pasteText.value = state.decryptedPaste.text || "";
  el.formatter.value = state.decryptedPaste.formatter || state.pasteMeta?.formatter || "plain";
  el.password.value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  showAlert("info", "Paste content cloned into the editor.", 2500);
}

async function copyShareLink() {
  if (!state.currentShareUrl) {
    showAlert("warning", "No share link available.");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.currentShareUrl);
    showAlert("success", "Share link copied.", 2000);
  } catch {
    showAlert("danger", "Clipboard write failed. Copy the URL manually.");
  }
}

function renderQrCode() {
  if (!state.currentShareUrl) {
    return;
  }

  el.qrHost.innerHTML = "";
  qrCode = new QRCode(el.qrHost, {
    text: state.currentShareUrl,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M
  });
}

async function deleteCurrentPaste() {
  if (!state.pasteId) {
    showAlert("warning", "No paste selected.");
    return;
  }

  if (!state.deleteToken) {
    showAlert("warning", "Delete token is unavailable in this browser session.");
    return;
  }

  const confirmed = window.confirm("Delete this paste permanently?");
  if (!confirmed) {
    return;
  }

  try {
    await apiJson(`/api/paste/${encodeURIComponent(state.pasteId)}`, {
      method: "DELETE",
      headers: {
        "X-Delete-Token": state.deleteToken
      }
    });

    showAlert("success", "Paste deleted.");
    prepareNewPaste();
  } catch (error) {
    showAlert("danger", `Delete failed: ${error.message}`);
  }
}

async function addEncryptedComment() {
  if (!state.pasteId || !state.masterKey) {
    showAlert("warning", "Open a paste before commenting.");
    return;
  }

  const text = el.newComment.value.trim();
  if (!text) {
    showAlert("warning", "Comment cannot be empty.");
    return;
  }

  try {
    const encrypted = await encryptText(text, state.masterKey);

    await apiJson(`/api/paste/${encodeURIComponent(state.pasteId)}/comment`, {
      method: "POST",
      body: JSON.stringify(encrypted)
    });

    el.newComment.value = "";
    await refreshComments();
    showAlert("success", "Comment added.", 2000);
  } catch (error) {
    showAlert("danger", `Could not add comment: ${error.message}`);
  }
}

async function refreshComments() {
  if (!state.pasteId || !state.masterKey) {
    return;
  }

  const data = await apiJson(`/api/paste/${encodeURIComponent(state.pasteId)}/comments`);
  const decrypted = [];

  for (const item of data.comments || []) {
    try {
      const text = await decryptToText({ iv: item.iv, ciphertext: item.ciphertext }, state.masterKey);
      decrypted.push({ createdAt: item.createdAt, text });
    } catch {
      decrypted.push({ createdAt: item.createdAt, text: "[Unable to decrypt this comment]" });
    }
  }

  renderComments(decrypted);
}

function renderComments(comments) {
  el.commentsList.innerHTML = "";

  if (!comments.length) {
    const empty = document.createElement("p");
    empty.className = "text-body-secondary mb-0";
    empty.textContent = "No comments yet.";
    el.commentsList.appendChild(empty);
    return;
  }

  for (const comment of comments) {
    const wrapper = document.createElement("article");
    wrapper.className = "comment-item";

    const stamp = document.createElement("div");
    stamp.className = "small text-body-secondary mb-2";
    stamp.textContent = new Date(comment.createdAt).toLocaleString();

    const content = document.createElement("pre");
    content.className = "mb-0";
    content.textContent = comment.text;

    wrapper.appendChild(stamp);
    wrapper.appendChild(content);
    el.commentsList.appendChild(wrapper);
  }
}

function renderDecryptedPaste(payload, meta) {
  const formatter = payload.formatter || meta.formatter || "plain";

  el.pasteRender.innerHTML = "";
  if (formatter === "markdown") {
    const html = marked.parse(payload.text || "");
    el.pasteRender.innerHTML = DOMPurify.sanitize(html);
  } else if (formatter === "code") {
    const code = document.createElement("code");
    code.className = "language-plaintext";
    code.textContent = payload.text || "";
    el.pasteRender.appendChild(code);
    hljs.highlightElement(code);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = payload.text || "";
    el.pasteRender.appendChild(pre);
  }

  if (payload.attachment) {
    if (state.attachmentUrl) {
      URL.revokeObjectURL(state.attachmentUrl);
    }

    const bytes = base64UrlToBytes(payload.attachment.data);
    const blob = new Blob([bytes], { type: payload.attachment.type || "application/octet-stream" });
    state.attachmentUrl = URL.createObjectURL(blob);

    el.attachmentLink.href = state.attachmentUrl;
    el.attachmentLink.download = payload.attachment.name || "attachment.bin";
    el.attachmentLink.textContent = `Download ${payload.attachment.name || "attachment"} (${formatBytes(payload.attachment.size || bytes.byteLength)})`;
    el.attachmentView.classList.remove("d-none");
  } else {
    el.attachmentView.classList.add("d-none");
  }

  const expiresText = meta.expiresAt ? new Date(meta.expiresAt).toLocaleString() : "Never";
  const burnText = meta.burnAfterReading ? "Yes" : "No";
  const discussionText = meta.openDiscussion ? "Open" : "Closed";
  el.pasteMeta.textContent = `Expires: ${expiresText} | Burn: ${burnText} | Discussion: ${discussionText}`;

  el.pasteViewSection.classList.remove("d-none");
  el.cloneBtn.disabled = false;
  el.deleteBtn.disabled = !state.deleteToken;
}

function toggleDiscussion(openDiscussion) {
  if (openDiscussion) {
    el.commentsSection.classList.remove("d-none");
  } else {
    el.commentsSection.classList.add("d-none");
  }
}

async function resolveKeyFromFragment() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  if (fragment.has("k")) {
    const raw = base64UrlToBytes(fragment.get("k"));
    return importMasterKey(raw.buffer);
  }

  if (fragment.has("wk") && fragment.has("wiv") && fragment.has("salt") && fragment.has("it")) {
    const password = el.password.value || window.prompt("This paste is password-protected. Enter password:");
    if (!password) {
      throw new Error("Password required for this paste.");
    }

    const wrappedKey = base64UrlToBytes(fragment.get("wk"));
    const wrapIv = base64UrlToBytes(fragment.get("wiv"));
    const salt = base64UrlToBytes(fragment.get("salt"));
    const iterations = Number(fragment.get("it"));

    const decryptKey = await derivePasswordKey(password, salt, iterations);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv }, decryptKey, wrappedKey);
    return importMasterKey(raw);
  }

  throw new Error("Missing decryption key in URL fragment.");
}

async function buildPlainPayload(text, formatter, file) {
  const payload = {
    text,
    formatter,
    createdAt: new Date().toISOString()
  };

  if (file) {
    payload.attachment = await fileToAttachment(file);
  }

  return payload;
}

async function fileToAttachment(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    data: bytesToBase64Url(new Uint8Array(buffer))
  };
}

async function buildFragment(masterKey, password) {
  const rawMaster = await crypto.subtle.exportKey("raw", masterKey);

  if (!password) {
    const p = new URLSearchParams({ k: bytesToBase64Url(new Uint8Array(rawMaster)) });
    return p.toString();
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 250000;

  const passwordKey = await derivePasswordKey(password, salt, iterations);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, passwordKey, rawMaster);

  const params = new URLSearchParams({
    wk: bytesToBase64Url(new Uint8Array(wrapped)),
    wiv: bytesToBase64Url(wrapIv),
    salt: bytesToBase64Url(salt),
    it: String(iterations)
  });

  return params.toString();
}

async function generateMasterKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function importMasterKey(rawBuffer) {
  return crypto.subtle.importKey("raw", rawBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function derivePasswordKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    material,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJson(value, key) {
  return encryptText(JSON.stringify(value), key);
}

async function encryptText(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);

  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

async function decryptToText(payload, key) {
  const iv = base64UrlToBytes(payload.iv);
  const ciphertext = base64UrlToBytes(payload.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function apiJson(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(buildApiUrl(path), {
    ...options,
    headers
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = json.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

function setCreateLoading(loading) {
  el.createBtn.disabled = loading;
  el.createSpinner.classList.toggle("d-none", !loading);
}

function showAlert(type, message, timeoutMs = 4500) {
  const wrapper = document.createElement("div");
  wrapper.className = `alert alert-${type} alert-dismissible fade show`;
  wrapper.role = "alert";
  wrapper.innerHTML = `${escapeHtml(message)}<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`;
  el.alertHost.innerHTML = "";
  el.alertHost.appendChild(wrapper);

  if (timeoutMs > 0) {
    window.setTimeout(() => {
      wrapper.classList.remove("show");
      wrapper.addEventListener("transitionend", () => wrapper.remove(), { once: true });
    }, timeoutMs);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}
