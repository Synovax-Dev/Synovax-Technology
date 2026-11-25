# SYNOVAX: an encrypted memory vault for AI

One place to keep what your AI should know about you. Everything is encrypted on your own device. Each AI app (Claude, Cursor, ChatGPT, and any other app that speaks MCP) can only read the folders you allow, and every read is written to a log that is sealed every hour.

> The product name lives in one place: [shared/brand.js](shared/brand.js). The landing page (`web/index.html`) still needs a manual edit if the name changes again.

## Run it

No install needed to try it: the hosted vault is at https://synovax.tech/vault/. To run your own copy:

Requires Node.js 22.13+ (tested on Node 24 and 26); `npm` and `npx` come with Node. SYNOVAX is on npm as [`synovax`](https://www.npmjs.com/package/synovax), with no dependencies:

```sh
npx synovax                  # start a vault server; data in ~/.synovax (DATA_DIR changes it)
npx synovax connector        # the connector, normally started by your AI app
npx synovax admin-password   # reset the admin password
npx synovax --help
```

Or from the code. The server **needs no `npm install`**; `npm start` only runs `node server/index.js` and keeps the data in `./data`. `npm install` is only for semantic search in the connector (optional, see below).

```sh
git clone https://github.com/Synovax-Dev/Synovax-Technology.git
cd Synovax-Technology
npm start
```

Then open http://127.0.0.1:8787/ (landing page) or go straight to http://127.0.0.1:8787/vault/.

```sh
npm test              # end-to-end
npm run test:ui       # browser
npm run test:wallet   # connect wallet and top holders
npm run test:immune   # hidden-instruction checks: every attack held, no false alarms
npm run test:vectors  # the open standard's test vectors
npm run test:extension # the browser extension, loaded into headless Chrome or Edge
```

**Browser tests (18 flows):** the real pages run in headless Chrome or Edge (no dependencies, driven over the DevTools protocol), from creating a vault to recovering it. A test fails on any JS error, CSP violation, failed request, or page that scrolls sideways at phone width. Set `UI_SHOTS=<folder>` to save desktop and phone screenshots.

**End-to-end tests (33 checks):** a real server, a "browser" built from the same crypto modules, and the connector driven over MCP. This includes a check that the database file **holds no plaintext at all**.

### Server settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` behind a reverse proxy. |
| `DATA_DIR` | `./data` (`~/.synovax` with `npx synovax`) | Database, secrets, backups. |
| `SEAL_PERIOD_MS` | `3600000` (1 hour) | How often the read log is sealed. |
| `ADMIN_PASSWORD` | random | Admin password on the very first start only (min. 12 characters). |
| `KDF_ITERATIONS` | `600000` | Every new vault must use this value, so the salt endpoint does not reveal which usernames exist. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the server (usually `1`), so rate limits use the real IP from `X-Forwarded-For`. Leave it at `0` if the server is reached directly, or the IP can be spoofed. |
| `TLS_CERT` + `TLS_KEY`, or `TLS_PFX` (+ `TLS_PFX_PASSPHRASE`) | | Serve HTTPS directly, without a reverse proxy. HSTS turns on automatically. |
| `BACKUP_INTERVAL_MS` | `21600000` (6 hours) | Automatic database copies in `data/backups/`. `0` turns them off. |
| `BACKUP_KEEP` | `14` | How many backups to keep. |
| `STATS_MIN_VAULTS` | `100` | The "live on this server" numbers on the landing page appear only once there are this many vaults. Until then the panel shows "early access". `0` always shows them. |
| `IMMUNE_TEST` | on | The public hourly test of the hidden-instruction checks (`/immune/`, `GET /api/immune`). `off` turns it off. |
| `SEAL_PUBLISH_URL` | | Every new seal is POSTed here (a Discord or Slack webhook, a log service), so a copy of the hash chain lives somewhere the server cannot change. |
| `CHAIN_RPC` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC used to count $SYNOVAX holders. |
| `HOLDERS_SOURCE` | `rpc` | `blockscout` reads holders from the Blockscout API (`EXPLORER_API`) instead. Its Cloudflare front may refuse datacenter IPs. |
| `EXPLORER_URL` | `https://robinhoodchain.blockscout.com` | Where holder and address links point. |
| `EXPLORER_API` | `EXPLORER_URL` | Blockscout API base. |
| `TOKEN_START_BLOCK` | `0` | Block the token was deployed in, so the first count is faster. |
| `HOLDERS_TTL_MS` | `60000` | How long the holder list is cached. |

Backups hold the same thing as the database (ciphertext and hashes), so keep them safe too. Copy that folder to another disk or machine: a backup on the same disk does not help if the disk dies.

**Sign-in limits:** only **failed** attempts count, per (username, IP), so someone guessing your passphrase cannot lock you out. There is also a cap of 200 failures per hour per account against guesses from many IPs, and it only blocks IPs that have already failed on that account.

## Connect Claude Desktop or Cursor

1. In the vault, go to **Apps**, name the app, tick the folders it may read, then **Create app key**.
2. Copy the MCP config it shows (the key is shown only once) into the app's config. For Claude Desktop: Settings → Developer → Edit Config.

```json
{
  "mcpServers": {
    "synovax": {
      "command": "npx",
      "args": ["-y", "synovax", "connector"],
      "env": { "VAULT_APP_KEY": "vlt_app.<id>.<secret>", "VAULT_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

On Windows, if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "synovax", "connector"]` (the vault does this when you make the key on Windows). A server started from a copy of the code shows `"command": "node"` with the path to its `connector/index.js` instead, which is what semantic search needs.

Tools the AI gets: `list_folders`, `search_memories`, `read_memory`, `suggest_memory` (suggestions land in your Inbox, and you approve them; 30 an hour per app).

### Hidden instructions (prompt injection)

Text from mail, chats and imports can carry lines written to steer an AI. `shared/immune.js` is the one place those checks live, used by the vault, the connector and the server:

- **On the way in**, the vault marks memories and suggestions that look like instructions for an AI, and imports leave them out unless you tick the box.
- **On the way out**, the connector drops invisible characters, replaces each flagged place (with its paragraph) by `[removed by SYNOVAX: ...]`, and quotes every memory between `<<data CODE>>` and `<<end CODE>>` with a code that is new for every answer.
- **On the record**, the connector reports the memory id (never the text) to `POST /api/app/caught`, and the read log gets a `caught` line, sealed like any read.
- **In public**, the server runs 14 attacks in 7 disguises through the same code every hour and publishes the round at `/immune/` and `GET /api/immune`, each round chained to the one before. There is no model in this test: it measures the checks.

### Semantic search (optional)

```sh
npm install
```

Run it once, in the vault folder. This is the project's only dependency, and only the connector uses it. The server runs fine without it. After that the AI can ask in plain sentences, in many languages: "what medicine should I avoid" finds the memory "I am allergic to penicillin".

- **The model runs on your computer.** Memory contents are never sent anywhere. The internet is used once, to download the model (from Hugging Face) into `.cache/models`.
- **Pick a model** with `VAULT_SEMANTIC` in the MCP config:
  - `bge-m3` (default): most accurate (14/14 on the test set), about 560 MB of disk, about 1 GB of RAM, indexing about 0.12 s per memory.
  - `e5-small`: about 130 MB and much faster, but less accurate (10/14 before keyword blending; often misses on vague questions).
  - `off`: keywords only.
- **The index is stored encrypted** in `.cache/index/`, with a key derived from the app key. Restarts need no reindex, and the index file is no easier to read than the vault itself.
- Every result is labeled `strong`, `possible`, or `words`. No model can be 100% sure that "nothing is relevant", so the AI is told how confident each result is.
- Search in the vault app (browser) stays keyword based. Semantic search is only in the connector, where the AI searches.
- Test: `npm run test:semantic` (downloads the model if needed). `VAULT_SEMANTIC=e5-small npm run test:semantic` for the small model.

## Layout

| Folder | Contents |
|---|---|
| `shared/` | Crypto (WebCrypto) and a Merkle tree. **The same code** runs in the browser and the connector. |
| `extension/` | The browser extension (Chrome, Edge and other Chromium browsers): saves a selection, a page or an AI chat to the inbox, sealed. `npm run extension` copies the shared crypto in and writes `web/extension/synovax-extension.zip`. |
| `bin/synovax.js` | The `synovax` command for `npx`: starts the server, the connector or the admin password reset, with the data in `~/.synovax`. |
| `server/` | HTTP API, SQLite (`node:sqlite`), the hourly log sealer, and the holder index (`holders.js`). |
| `web/vault/` | The vault app (plain JS, no build step). Sign-in page with a ciphertext art panel, sign in / create / recover forms with a passphrase strength meter, Caps Lock warning, and the 24-word recovery screen. Dashboard with a dark sidebar, stats strip, and a sliding editor. Entry animations run only when the view changes and are off under `prefers-reduced-motion`. |
| `web/index.html`, `web/landing.css`, `web/landing/` | Landing page: animation engine (springs, text reveals, scroll), WebGL hero, a memory graph, a live Merkle seal using real SHA-256 in the browser, the MCP flow, and the $SYNOVAX section with the coin, connect wallet (`wallet.js`) and top holders. The security section (`security.js`) lists only facts that exist in the code. Fonts are self-hosted in `web/fonts/`. |
| `site/pages/`, `web/pages/` | The information pages: how it works, security, threat model, immune system, privacy, status, connector, API reference, open standard, verify, open source. Sources in `site/pages/`, built into `web/<page>/index.html` by `npm run pages` (the browser test fails if a built page is out of date). Status, immune, seals and verify are live, in `web/pages/*.js`. |
| `shared/vectors.json` | The open standard's test vectors, made by `npm run vectors` from the code and checked by `npm run test:vectors`. |
| `web/docs/` | Docs at `/docs/`: from zero to self-hosting, the API, the security model, troubleshooting. Search (press `/`), a table of contents, tabs per MCP app, copy buttons. |
| `web/admin/` | Admin panel for publishing token info (status, contract address, explorer link, X account, supply, launch date). |
| `connector/` | The MCP server (stdio) that runs on the user's computer. |
| `test/` | End-to-end, browser, wallet and semantic tests. |

## Admin panel ($SYNOVAX)

Open http://127.0.0.1:8787/admin/ and sign in with the admin password.

- **First start:** the password comes from `ADMIN_PASSWORD`. If it is not set, a random one is printed once in the server log. Only a scrypt hash is stored, in `data/admin-password`.
- **Change it** in the panel (the current password is required, and every other admin session is signed out).
- **Forgot it?** On the server, run `npm run admin:password` (prints a new random one) or `npm run admin:password -- "<new password>"`. This also signs out every admin session.
- What you fill in appears in the landing page's `#token` section and the X link in the footer once you press **Publish**.
- **A new contract address must be confirmed** by typing its last 6 characters. Status `live` needs a contract address.
- Once a contract address is set, the top 20 holders appear on the landing page automatically. They are counted from the token's Transfer events and confirmed with `balanceOf`. Checked against Blockscout on a real token (LINK on Robinhood Chain): the top 20, the holder count and the supply matched exactly. If the RPC is down, the last list stays up, marked "cached".
- Every change is logged (time, IP, field, old and new value) and shown in the panel. If two people edit at once, the later save is rejected (409) so nobody overwrites the other.
- Only failed sign-ins count toward the limit: 5 per 15 minutes per IP. An admin session lasts 12 hours and is kept only in that tab (`sessionStorage`). Restarting the server signs out every admin session.
- When deployed: **HTTPS is required**, and never share the admin password over chat or DMs.

### Connect wallet

Connect wallet on the landing page is read only. It asks for the address, can switch to or add Robinhood Chain (chain ID 4663), and reads the balance with `eth_call`. It never asks for a signature, an approval or a transaction. It supports EIP-6963 wallet discovery, with `window.ethereum` as a fallback.

## How the encryption works

```
passphrase ──PBKDF2 600k──▶ master ──HKDF──▶ authKey  (sent to the server, stored as a hash)
                                     └─────▶ kek      (never leaves the device)
24 recovery words ──HKDF──▶ master ──▶ authKey / kek  (backup path)

vault key (random)   wrapped with kek and the recovery kek
folder key (random)  wrapped with the vault key and with the wrap key of each allowed app
memory               AES-256-GCM with the folder key; the AAD binds the ciphertext to its id
inbox                ECDH P-256 key pair; apps seal suggestions to the vault's public key
app key              vlt_app.<id>.<secret> ──HKDF──▶ auth (server keeps only a hash) / wrap / vouch
```

- **The server sees only:** the username, how much data there is and its size, timestamps, and which app read which memory id when.
- **The server cannot see:** titles, contents, tags, folder names, app names, what the AI searched for, or any key.
- **Vouch:** the vault HMACs its inbox public key with a key only the vault and the app hold, so the server cannot quietly swap the public key to read suggestions.
- **Seal:** every period, all log leaves (salted) are combined into one Merkle root. The Read log page can verify any entry against its public seal, right in the browser.
- **Seal chain:** each seal commits to the hash of the previous one. The browser remembers the last hash it saw and checks on every visit to the Read log that the chain still connects from there. If the server rewrites or deletes an old seal, it shows.
- **Folder key rotation:** when a folder is removed from an app (or the app is revoked), that folder gets a new key and all its memories are re-encrypted in the browser. The old key the app held cannot open anything written afterwards. You can also do it by hand: open the folder, then **Replace key**.
- **Signed-in devices:** Settings → Signed-in devices. Sign out one at a time or all at once.
- **Two-step sign-in (2FA):** Settings → Turn on. 6-digit codes from an authenticator app, each code usable once. The secret is stored encrypted with a key from `server-secret`. Recovering with the 24 words also turns 2FA off (for when the phone is lost).
- **Import:** Settings → Import. Paste a memory list from ChatGPT or Claude (one fact per line) or a vault export file. Duplicates are skipped, and everything is encrypted in the browser.
- **Connector search:** forgiving keywords (accents folded, light stemming, one typo allowed, common synonyms, rare words weighted higher), plus **semantic search** when enabled (see above).
- **Phones:** `/vault/` can be installed to the home screen (manifest and icons), and every page is tested not to scroll sideways at 390px.
- **Delete means delete:** `PRAGMA secure_delete=ON`.
- Strict CSP (`script-src 'self'`), no third-party scripts or fonts.

## Known limits

- **Not audited yet.** The design follows standard patterns, but before storing other people's sensitive data, have a third party audit it.
- If both the passphrase **and** the 24 recovery words are lost, nobody can open the vault. That is by design.
- Removing a folder from an app rotates its key, so new content is safe. Anything the app already read, it may have kept. That cannot be undone.
- Semantic search is not perfect: on vague questions ("what do I drink in the morning") the model can rank a similar memory ("Morning person") above the right one; the right one still makes the top 3. Unrelated questions sometimes still get results labeled `possible`.
- The seal chain is only as strong as its witnesses: your browser (per browser) and `SEAL_PUBLISH_URL` if set. Without either, the seals live only on the server.
- The Inbox checks automatically every 30 seconds (and when the tab is opened again). If you are typing, the screen is not refreshed so nothing you typed is lost; a notice appears instead.
- For production: put it behind HTTPS (a reverse proxy), set `HOST=0.0.0.0` and `TRUST_PROXY=1`, and back up `DATA_DIR`.
- The sign-up endpoint still says when a name is taken ("That name is taken"). This cannot be avoided while users pick their own usernames.
- The landing page stays under a strict CSP: self-hosted fonts, no CDN, no inline scripts or styles. If you add outside assets later, add their domains to the CSP header in `server/index.js` (`SECURITY_HEADERS`).

## Not built yet (next version candidates)

Passkey sign-in (WebAuthn PRF), semantic search in the vault app (browser), "AI self", a browser extension, sharing folders between vaults, native phone apps.

## License

[MIT](LICENSE). Free to use, change and distribute, including commercially, as long as the copyright and license notice are kept.
