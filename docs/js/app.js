const GITHUB_PAT = "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";
const THEME_STORAGE_KEY = "codexbin-theme";

const state = {
  pasteId: null,
  pasteMeta: null,
  masterKey: null,
  decryptedPaste: null,
  currentShareUrl: "",
  attachmentUrl: null,
  gistFiles: null // Store gist files for downloading attachments
};

const el = {
  alertHost: document.getElementById("alertHost"),
  pasteText: document.getElementById("pasteText"),
  expiration: document.getElementById("expiration"),
  formatter: document.getElementById("formatter"),
  password: document.getElementById("password"),
  attachment: document.getElementById("attachment"),
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
  const moon = document.getElementById("themeMoonIcon");
  const sun = document.getElementById("themeSunIcon");
  if (moon && sun) {
    if (theme === "dark") {
      moon.classList.remove("d-none");
      sun.classList.add("d-none");
    } else {
      moon.classList.add("d-none");
      sun.classList.remove("d-none");
    }
  }
}

async function githubApiJson(path, options = {}) {
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "Authorization": `token ${GITHUB_PAT}`,
    ...(options.headers || {})
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers
  });

  if (response.status === 204) return null;

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = json.message || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

async function createPaste() {
  const text = el.pasteText.value;
  const file = el.attachment.files[0];

  if (!text && !file) {
    showAlert("warning", "Provide text or a file attachment before creating a paste.");
    return;
  }

  if (GITHUB_PAT === "YOUR_GITHUB_PAT_HERE") {
    showAlert("danger", "GitHub PAT not configured. Set GITHUB_PAT in app.js.");
    return;
  }

  setCreateLoading(true);

  try {
    const formatter  = el.formatter.value;
    const masterKey  = await generateMasterKey();
    const fragment   = await buildFragment(masterKey, el.password.value);

    const plainPayload    = { text, formatter, createdAt: new Date().toISOString() };
    const encryptedPayload = await encryptJson(plainPayload, masterKey);

    const pasteBody = {
      ciphertext:      encryptedPayload.ciphertext,
      iv:              encryptedPayload.iv,
      expiration:      el.expiration.value,
      burnAfterReading: el.burnAfterReading.checked,
      openDiscussion:  el.openDiscussion.checked,
      formatter
    };

    const files = {};

    if (file) {
      if (file.size > 1024 * 1024) {
        throw new Error("Attachment too large for GitHub Gists (max 1MB).");
      }
      const buffer = await file.arrayBuffer();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedFile = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, buffer);
      
      const attachmentMeta = {
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        iv: bytesToBase64Url(iv)
      };
      
      pasteBody.hasAttachment = true;
      pasteBody.attachmentMeta = attachmentMeta;
      
      files["attachment.b64"] = {
        content: bytesToBase64Url(new Uint8Array(encryptedFile))
      };
    }

    files["paste.json"] = {
      content: JSON.stringify(pasteBody)
    };

    const response = await githubApiJson("/gists", {
      method: "POST",
      body: JSON.stringify({
        description: "CodexBin Paste",
        public: false,
        files: files
      })
    });

    const shareUrl = `${window.location.origin}${window.location.pathname}?p=${encodeURIComponent(response.id)}#${fragment}`;

    state.pasteId   = response.id;
    state.pasteMeta = pasteBody;
    state.pasteMeta.createdAt = new Date().toISOString();
    state.masterKey       = masterKey;
    state.decryptedPaste  = plainPayload;
    state.currentShareUrl = shareUrl;
    state.gistFiles       = response.files;

    history.replaceState(null, "", `?p=${encodeURIComponent(response.id)}#${fragment}`);

    renderDecryptedPaste(plainPayload, state.pasteMeta);
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
  const params  = new URLSearchParams(window.location.search);
  const pasteId = params.get("p");
  if (!pasteId) return;

  if (GITHUB_PAT === "YOUR_GITHUB_PAT_HERE") {
    showAlert("danger", "GitHub PAT not configured. Set GITHUB_PAT in app.js.");
    return;
  }

  try {
    const response = await githubApiJson(`/gists/${encodeURIComponent(pasteId)}`);
    const pasteFile = response.files["paste.json"];
    if (!pasteFile) throw new Error("Invalid paste gist.");
    
    let pasteMeta = JSON.parse(pasteFile.content);
    pasteMeta.createdAt = response.created_at;

    // Check expiration
    const createdAt = new Date(response.created_at).getTime();
    const now = Date.now();
    let expired = false;
    
    if (pasteMeta.expiration === "5min" && now - createdAt > 5 * 60 * 1000) expired = true;
    else if (pasteMeta.expiration === "1hr" && now - createdAt > 60 * 60 * 1000) expired = true;
    else if (pasteMeta.expiration === "1day" && now - createdAt > 24 * 60 * 60 * 1000) expired = true;
    else if (pasteMeta.expiration === "1week" && now - createdAt > 7 * 24 * 60 * 60 * 1000) expired = true;
    
    if (expired) {
      await githubApiJson(`/gists/${encodeURIComponent(pasteId)}`, { method: "DELETE" }).catch(() => {});
      throw new Error("Paste has expired.");
    }

    const key = await resolveKeyFromFragment();
    const plaintext = await decryptToText({ iv: pasteMeta.iv, ciphertext: pasteMeta.ciphertext }, key);
    const payload = JSON.parse(plaintext);

    state.pasteId         = pasteId;
    state.pasteMeta       = pasteMeta;
    state.masterKey       = key;
    state.decryptedPaste  = payload;
    state.currentShareUrl = window.location.href;
    state.gistFiles       = response.files;

    renderDecryptedPaste(payload, pasteMeta);
    toggleDiscussion(pasteMeta.openDiscussion);

    if (pasteMeta.openDiscussion) {
      try { await refreshComments(); } catch { renderComments([]); }
    }

    if (pasteMeta.burnAfterReading) {
      await githubApiJson(`/gists/${encodeURIComponent(pasteId)}`, { method: "DELETE" }).catch(() => {});
      showAlert("success", "Paste opened. Burn-after-reading: deleted from server.", 7000);
    } else {
      showAlert("success", "Paste decrypted successfully.", 7000);
    }
  } catch (error) {
    showAlert("danger", `Could not open paste: ${error.message}`);
  }
}

function prepareNewPaste() {
  state.pasteId = null;
  state.pasteMeta = null;
  state.masterKey = null;
  state.decryptedPaste = null;
  state.currentShareUrl = "";
  state.gistFiles = null;

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

  el.qrHost.textContent = "";
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

  const confirmed = window.confirm("Delete this paste permanently?");
  if (!confirmed) {
    return;
  }

  try {
    await githubApiJson(`/gists/${encodeURIComponent(state.pasteId)}`, {
      method: "DELETE"
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
    const commentBody = JSON.stringify(encrypted);

    await githubApiJson(`/gists/${encodeURIComponent(state.pasteId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: commentBody })
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

  const comments = await githubApiJson(`/gists/${encodeURIComponent(state.pasteId)}/comments`);
  const decrypted = [];

  for (const item of comments || []) {
    try {
      const parsed = JSON.parse(item.body);
      const text = await decryptToText({ iv: parsed.iv, ciphertext: parsed.ciphertext }, state.masterKey);
      decrypted.push({ createdAt: item.created_at, text });
    } catch {
      decrypted.push({ createdAt: item.created_at, text: "[Unable to decrypt this comment]" });
    }
  }

  renderComments(decrypted);
}

function renderComments(comments) {
  el.commentsList.textContent = "";

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

  el.pasteRender.textContent = "";
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

  if (meta.hasAttachment && meta.attachmentMeta) {
    const am = meta.attachmentMeta;
    el.attachmentLink.textContent = `Download ${am.name || "attachment"} (${formatBytes(am.size || 0)})`;
    el.attachmentLink.removeAttribute("href");
    el.attachmentLink.removeAttribute("download");
    el.attachmentLink.onclick = async (e) => {
      e.preventDefault();
      if (state.attachmentUrl) {
        triggerDownload(state.attachmentUrl, am.name || "attachment.bin");
        return;
      }
      el.attachmentLink.textContent = "Downloading…";
      try {
        const attachmentFile = state.gistFiles["attachment.b64"];
        if (!attachmentFile) throw new Error("Attachment file not found in Gist");
        
        let content = attachmentFile.content;
        if (attachmentFile.truncated) {
          const rawRes = await fetch(attachmentFile.raw_url);
          content = await rawRes.text();
        }
        
        const encryptedBuffer = base64UrlToBytes(content).buffer;
        const iv = base64UrlToBytes(am.iv);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv }, state.masterKey, encryptedBuffer
        );
        const blob = new Blob([decrypted], { type: am.type || "application/octet-stream" });
        state.attachmentUrl = URL.createObjectURL(blob);
        triggerDownload(state.attachmentUrl, am.name || "attachment.bin");
        el.attachmentLink.textContent = `Download ${am.name} (${formatBytes(am.size || decrypted.byteLength)})`;
      } catch (err) {
        showAlert("danger", `Attachment download failed: ${err.message}`);
        el.attachmentLink.textContent = `Download ${am.name || "attachment"} (${formatBytes(am.size || 0)})`;
      }
    };
    el.attachmentView.classList.remove("d-none");
  } else {
    el.attachmentView.classList.add("d-none");
  }

  let expiresText = "Never";
  if (meta.expiration !== "never") {
    expiresText = meta.expiration; 
  }
  const burnText = meta.burnAfterReading ? "Yes" : "No";
  const discussionText = meta.openDiscussion ? "Open" : "Closed";
  el.pasteMeta.textContent = `Expires: ${expiresText} | Burn: ${burnText} | Discussion: ${discussionText}`;

  el.pasteViewSection.classList.remove("d-none");
  el.cloneBtn.disabled = false;
  el.deleteBtn.disabled = false;
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

function setCreateLoading(loading) {
  el.createBtn.disabled = loading;
  el.createSpinner.classList.toggle("d-none", !loading);
}

function showAlert(type, message, timeoutMs = 4500) {
  const wrapper = document.createElement("div");
  wrapper.className = `alert alert-${type} alert-dismissible fade show d-flex justify-content-between align-items-center`;
  wrapper.role = "alert";

  const textSpan = document.createElement("span");
  textSpan.textContent = message;
  wrapper.appendChild(textSpan);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn-close";
  closeBtn.setAttribute("data-bs-dismiss", "alert");
  closeBtn.setAttribute("aria-label", "Close");
  wrapper.appendChild(closeBtn);

  el.alertHost.textContent = "";
  el.alertHost.appendChild(wrapper);

  if (timeoutMs > 0) {
    window.setTimeout(() => {
      wrapper.classList.remove("show");
      wrapper.addEventListener("transitionend", () => wrapper.remove(), { once: true });
    }, timeoutMs);
  }
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

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
