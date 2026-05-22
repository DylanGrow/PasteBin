# CodexBin

CodexBin is a serverless, encrypted pastebin that stores your pastes as **GitHub Secret Gists**. It has no custom backend server; the frontend talks directly to the GitHub API.

- **Static Frontend**: Can be hosted on GitHub Pages (`docs/` folder).
- **GitHub Backend**: Uses GitHub Secret Gists to store data.
- **Client-Side Encryption**: AES-256-GCM client-side encryption using the Web Crypto API.
- **Zero Knowledge**: URL fragment key transport (`#...`) ensures the GitHub API never sees plaintext keys.
- **Features**: Optional password protection, encrypted comments, self-destruct (burn-after-reading), attachments (up to 1MB), syntax rendering.

## Setup Instructions

### 1. Generate a GitHub Personal Access Token (PAT)

Since the app creates Gists on your behalf, you must supply a GitHub Personal Access Token:
1. Go to your GitHub account settings -> **Developer settings** -> **Personal access tokens** -> **Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Give it a name (e.g., "CodexBin") and check the `gist` scope.
4. Set the expiration to "No expiration" or whatever you prefer.
5. Generate and copy the token.

### 2. Configure the Frontend

1. Open `docs/js/app.js`.
2. At the very top of the file, replace the placeholder with your token:
   ```javascript
   const GITHUB_PAT = "ghp_your_actual_token_here";
   ```
   **Warning**: If you deploy this publicly, anyone can view your token in the source code. This setup is intended for private self-hosting or personal use.

### 3. Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings -> Pages**.
3. Under "Build and deployment", set **Source** to `GitHub Actions`.
4. The workflow in `.github/workflows/deploy.yml` will automatically deploy your `docs/` folder to GitHub Pages.

## How it works

- **Create Paste**: `POST https://api.github.com/gists`. Creates a Secret Gist containing `paste.json` and optionally `attachment.b64`.
- **View Paste**: `GET https://api.github.com/gists/:id`.
- **Delete Paste**: `DELETE https://api.github.com/gists/:id`.
- **Comments**: Uses GitHub's built-in Gist comments API (`POST /gists/:id/comments`).

*Note: Gists don't support native time-to-live (TTL). The frontend enforces expiration by deleting the Gist upon retrieval if the expiration time has passed, or if burn-after-reading is enabled.*