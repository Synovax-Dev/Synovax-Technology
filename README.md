# SYNOVAX — brankas memori AI terenkripsi

Satu tempat buat nyimpen apa yang AI lu harus tahu tentang lu. Isinya dienkripsi di device lu sendiri. Tiap aplikasi AI (Claude, Cursor, ChatGPT, dan app lain yang ngerti MCP) cuma bisa baca folder yang lu izinin, dan tiap kali dia baca, kecatat di log yang disegel tiap jam.

> Nama produk diatur di satu tempat: [shared/brand.js](shared/brand.js). Landing page (`web/index.html`) masih perlu diganti manual kalau namanya berubah lagi.

## Jalanin

Butuh Node.js 22.13+ (dites di Node 24). **Tanpa `npm install`**, karena nggak ada dependency sama sekali.

```powershell
npm start
```

Terus buka http://127.0.0.1:8787/ (landing page) atau langsung http://127.0.0.1:8787/vault/.

```powershell
npm test
```

Test end-to-end (23 cek): server beneran, "browser" yang dibikin dari modul kripto yang sama, dan connector yang diajak ngobrol lewat MCP. Termasuk cek bahwa file database **nggak nyimpen plaintext sama sekali**.

Env server: `PORT` (8787), `HOST` (127.0.0.1), `DATA_DIR` (`./data`), `SEAL_PERIOD_MS` (3600000 = 1 jam), `ADMIN_KEY` (opsional, min. 32 karakter).

## Nyambungin ke Claude Desktop / Cursor

1. Di vault → **Apps** → kasih nama app, centang folder yang boleh dibaca → **Create app key**.
2. Copy config MCP yang muncul (key-nya cuma ditampilin sekali) ke config app-nya. Buat Claude Desktop: Settings → Developer → Edit Config.

```json
{
  "mcpServers": {
    "synovax": {
      "command": "node",
      "args": ["C:\\path\\ke\\vault\\connector\\index.js"],
      "env": { "VAULT_APP_KEY": "vlt_app.<id>.<secret>", "VAULT_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

Tools yang didapet AI: `list_folders`, `search_memories`, `read_memory`, `suggest_memory` (usulan masuk Inbox, lu yang approve).

## Struktur

| Folder | Isi |
|---|---|
| `shared/` | Kripto (WebCrypto) + Merkle tree. **Kode yang sama** dipake browser dan connector |
| `server/` | HTTP API + SQLite (`node:sqlite`) + penyegel log per jam |
| `web/vault/` | Aplikasi vault (JS murni, tanpa build step). Halaman login: `auth-art.js` (panel ciphertext + lensa "your key"), form sign in / create / recover dengan meter kekuatan passphrase, cek Caps Lock, dan layar 24 kata pemulihan. Dashboard: sidebar gelap dengan penanda nav yang geser, judul Oswald, strip statistik, editor yang slide masuk. Animasi masuk cuma jalan saat view berganti (`motion` di `render()`), dan mati kalau `prefers-reduced-motion` |
| `web/index.html`, `web/landing.css`, `web/landing/` | Landing page: engine animasi (spring, reveal teks, scroll), scene WebGL hero, section lain, plus showpiece animasi (`effects.js`: partikel, marquee, enkripsi live; `showcase.js`: graph memori (folder sebagai lingkaran, kabel dari app ke memori yang cocok, folder terkunci di-hatch), segel Merkle pakai SHA-256 asli di browser, alur MCP; `coin.js`: koin $SYNOVAX di section token). Section keamanan (`security.js`) isinya fakta yang beneran ada di kode, bukan klaim audit/DDoS. Font di-host sendiri di `web/fonts/` |
| `web/docs/` | Halaman docs di `/docs/`: tutorial dari nol sampai self-host, API, model keamanan, troubleshooting. Ada search (tekan `/`), daftar isi, tab per app MCP, tombol copy |
| `web/admin/` | Admin panel buat posting info token (status, CA, link explorer, akun X, supply, tanggal launch) |
| `connector/` | MCP server (stdio) yang jalan di komputer user |
| `test/` | Test end-to-end |

## Admin panel ($SYNOVAX)

Buka http://127.0.0.1:8787/admin/ terus masukin admin key.

- **Key-nya:** pas server pertama jalan, dibikinin acak dan disimpen di `data/admin-key`. Liat pake `Get-Content data\admin-key`. Mau pake key sendiri? Set env `ADMIN_KEY` (min. 32 karakter). Server cuma nyimpen hash-nya di memori.
- **Ganti key:** hapus `data/admin-key` lalu restart server (atau ganti `ADMIN_KEY`). Tiap restart, semua sesi admin lama otomatis ke-logout.
- Yang diisi di panel langsung muncul di section `#token` landing + link X di footer, setelah lu pencet **Publish**.
- **CA baru wajib dikonfirmasi** dengan ngetik 6 karakter terakhirnya. Status `live` cuma bisa kalau CA udah diisi.
- Tiap perubahan dicatet (waktu, IP, field, nilai lama → baru) dan keliatan di panel. Kalau dua orang ngedit barengan, yang telat ditolak (409) biar nggak saling timpa.
- Login dibatesin 5x per 15 menit per IP. Sesi admin berlaku 12 jam, cuma disimpen di tab itu (`sessionStorage`).
- Kalau di-deploy: **wajib HTTPS**, dan jangan share admin key lewat chat/DM.

## Cara kerja enkripsinya

```
passphrase ──PBKDF2 600k──▶ master ──HKDF──▶ authKey  (dikirim ke server, disimpen sebagai hash)
                                     └─────▶ kek      (nggak pernah keluar dari device)
24 kata recovery ──HKDF──▶ master ──▶ authKey / kek   (jalur cadangan)

vault key (acak)   dikunci pake kek dan kek-recovery
folder key (acak)  dikunci pake vault key + pake wrap-key tiap app yang dikasih izin
memori             AES-256-GCM pake folder key, AAD ngiket ciphertext ke id-nya
inbox              keypair ECDH P-256; app nge-seal usulan ke public key vault
app key            vlt_app.<id>.<secret> ──HKDF──▶ auth (server cuma simpen hash) / wrap / vouch
```

- **Server cuma liat:** username, jumlah dan ukuran data, waktu, app mana baca memori id berapa kapan.
- **Server nggak bisa liat:** judul, isi, tag, nama folder, nama app, kata yang dicari AI, semua kunci.
- **Vouch:** vault nge-HMAC public key inbox-nya pake kunci yang cuma dipegang vault + app. Jadi server nggak bisa diem-diem nuker public key buat ngintip usulan.
- **Seal:** tiap periode, semua leaf log (di-salt) digabung jadi satu Merkle root. Halaman Read log bisa verifikasi entri apa pun ke seal publiknya, langsung di browser.
- **Hapus = hapus beneran:** `PRAGMA secure_delete=ON`.
- CSP ketat (`script-src 'self'`), tanpa script/font pihak ketiga.

## Batasan yang perlu lu tahu

- **Belum diaudit.** Desainnya mengikuti pola standar, tapi sebelum nyimpen data sensitif orang lain, minta pihak ketiga audit dulu.
- Kalau passphrase **dan** 24 kata recovery ilang, vault nggak bisa dibuka siapa pun. Itu disengaja.
- Nyabut folder dari app ngehentiin server ngasih data baru. Tapi kalau app-nya udah sempet baca, dia bisa nyimpen salinan. Rotasi folder key belum ada.
- Pencarian di connector masih pake kata kunci, belum semantic/embedding.
- Seal disimpen di server sendiri (belum dipublikasi ke tempat publik yang nggak bisa diubah).
- Inbox nggak auto-refresh, jadi pake tombol Refresh.
- Buat production: taruh di belakang HTTPS (reverse proxy), set `HOST=0.0.0.0`, dan backup `DATA_DIR`.
- Landing page tetep di bawah CSP ketat: font di-host sendiri, tanpa CDN, tanpa inline script/style. Kalau nanti nambah aset dari luar, header CSP di `server/index.js` (`SECURITY_HEADERS`) perlu ditambahin domainnya.

## Belum dibikin (kandidat versi berikutnya)

Login passkey (WebAuthn PRF), import export ChatGPT/Claude, semantic search lokal, "AI self", browser extension, berbagi folder antar-vault, versi HP.
