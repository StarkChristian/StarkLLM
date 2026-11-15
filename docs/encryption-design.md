# StarkLLM Protection at Rest and Encrypted Backup — Design

Status: **implemented (draft PR), needs a manual test on Windows** (roadmap B6 and B7 of `docs/document-inbox-design.md`).

The product promise is that documents never leave the PC. This note says what happens to them *on* the PC: what
is locked, against whom, with which key, and what happens when the key is lost. It is written so that the promise
can be checked, so it also lists what is **not** protected.

## 1. Threat model

| # | Situation | Protected? |
|---|---|---|
| 1 | **Lost or stolen laptop.** Someone starts the PC from another system or removes the disk and copies the data folder. | **Yes**, if the Windows account is not open. The files are encrypted; the key is wrapped by Windows (DPAPI) for this user, so it cannot be opened without signing in to this Windows account. BitLocker is still recommended: it also covers the programs, the models and the names of files (see below). |
| 2 | **Another Windows user on the same PC.** | **Yes.** DPAPI wrappers are bound to the user account. The data folder lives in the user's own profile. |
| 3 | **Backups copied to cloud folders, USB sticks or a NAS.** | **Yes.** A backup is one file encrypted with a key derived from a passphrase (Argon2id). Without the passphrase it is noise. A plain copy of the data folder is also protected while protection at rest is on (it has no key in it). |
| 4 | **Malware reading the data folder** (reads files, runs as another user, or runs from a stolen disk image). | **Yes** for malware that runs as another user or reads the disk offline. |
| 5 | **Malware running as you while StarkLLM is open.** | **No.** It can ask Windows to unwrap the same key, read the engine's memory, or read the screen. No at-rest encryption can help here. |
| 6 | **Someone using your open, signed-in Windows session.** | **No** (unless the optional passphrase is on: then StarkLLM does not start its protected data without it). |
| 7 | **Forensic recovery of deleted plain files.** After protection is turned on, the plain originals are replaced; SSDs and file systems may still keep old blocks. | **Partly.** The database files are rewritten (`VACUUM`) so old plain text is gone from them; plain files that were replaced cannot be wiped reliably from userland. BitLocker closes this gap. |
| 8 | **Someone who watches network traffic.** | Not a topic here: the engine listens on `127.0.0.1` only. |

What protection at rest does **not** do: hide that StarkLLM is installed, hide how many documents exist and how big
they are, hide file names and chat titles (see 2), protect the knowledge base folder (it holds the user's own files, which
StarkLLM only reads), protect against a user who gives the key away (recovery key, passphrase), or protect data
that StarkLLM sends nowhere by design but that the user exports (downloads, copy and paste).

## 2. What is encrypted

| Data | Where | How |
|---|---|---|
| Uploaded documents (originals: PDF, photos, Word, text) | `data/uploads/` | whole file, AES-256-GCM in chunks (`SLLMENC` format, `core/crypto.py`), stored under the **same path and name**, so no database row and no search entry changes |
| Chat messages and their source chips | database `messages.content`, `messages.sources` | column value, AES-256-GCM, `ProtectedText` column type |
| Profile text, custom instructions, workspace instructions, prompt templates | `users`, `workspaces`, `prompt_templates` | same |
| Inbox decisions (own title, case) — they contain sender names | `document_reviews` | same |
| **Names and titles:** workspace names, chat folder names, chat titles, document file names, prompt template titles and tags, indexing error messages (they quote file names) | `workspaces.name`, `chat_folders.name`, `chats.title`, `documents.filename`, `documents.error_message`, `prompt_templates.title`, `prompt_templates.tags`, `knowledge_base_documents.error_message` | same column type. Searching them is done after reading (section 2.1) |
| Name of a **new** upload on disk | `data/uploads/` | while protection is on, a new upload is stored as `<random>.<extension>` (the name the user sees is in the protected `documents.filename`); with protection off it is `<hash>_<name>` as before |
| Text of every indexed chunk and every memory (this is the document content again) | ChromaDB (`documents` field) | value encrypted by `ProtectedCollection` before it reaches ChromaDB |
| Extracted facts (sender, amounts, IBANs, deadlines) | computed on demand from the chunk text above and kept in memory only; the user's corrections are in `document_reviews` | protected through the two lines above; nothing else is stored |
| Logs | the engine does not log document text or message text (checked: it logs file names and counts). The desktop `engine.log` has no document text. | nothing to encrypt; a test (`test_protection_at_rest.py`) searches the data folder for leaked plain text |
| Backups | one `.starkbackup` file | AES-256-GCM, key from the passphrase |

**Not encrypted, on purpose, and said so in the Settings page:**

* **Knowledge Base file names, folder names and paths** (`knowledge_base_documents.file_name/file_path`,
  `knowledge_base_folders.folder_name/folder_path`): these are the user's own files in a visible folder; the same names
  stand in clear in Windows Explorer and in `file_path`, which must stay readable because the folder watcher compares it with
  the disk. Encrypting the copy in the database would protect nothing;
* **names of uploads made before protection was turned on** (`data/uploads/<hash>_<name>`, `documents.filepath`) and the
  `source` / `file_name` fields in the search index: renaming the files needs the index to change as well, which belongs to the
  encrypted-index work; only new uploads get opaque names;
* user names (the login) and numbers, dates, statuses, ids, file types and sizes (needed to sort and join; they carry no text);
* **in the default search index (ChromaDB)**: the embeddings (the numbers used for similarity search) and the metadata next to each
  chunk (file name, page, chunk number, source path). They reveal topics and, with effort, can be partly inverted into
  words. This exposure is removed by switching on the **encrypted search index** (section 10), which is optional because it
  costs memory and start-up time; the page in Settings says so;
* the SQLite structure (table and column names, row counts, dates);
* the user's Knowledge Base folder (their own files).

### 2.1 Searching names and titles that are encrypted

SQL `LIKE` cannot search an encrypted column. Two ways were built and measured (`backend/tools/bench_label_search.py`; chat
titles of 3-7 words, one search term that matches about 12 % of the rows, Linux container, median of 5 runs):

| rows | plain SQL (protection off) | **decrypt in memory, first search** | **decrypt in memory, repeated** | blind index (prototype) query | blind index build | blind index size |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 0.5 ms | 7 ms | 2 ms | 2 ms | 0.2 s | 1.5 MB |
| 10,000 | 2 ms | 66 ms | 19 ms | 36 ms | 1.9 s | 16 MB |
| 50,000 | 7 ms | 162 ms | 72 ms | 238 ms | 8.4 s | 81 MB |

*(Reading whole rows as objects instead of id and title only was 2-5 times slower, 508 ms at 50,000 rows; the engine reads
only id and title.)*

**Chosen: decrypt in memory.** The rows of the signed-in user are read, the short texts are decrypted (and kept in memory
until the engine is locked, never on disk), and compared with a case-insensitive "contains" (also for Ä/ä, which SQL
`ILIKE` does not do). It needs no extra table and no extra key, stays under 100 ms for 10,000 names or titles, and a user
has far fewer than that. The blind index was **not** built into the product: it is not faster than the repeated in-memory
search, it needs 16-80 MB and seconds to build, and it would leak to anyone with the database file which rows share a
three-letter piece (the frequency pattern of the language: "ein", "ung", ...), which is exactly what encrypting titles is
meant to hide.

What stays visible in the database for these rows: that the row exists, its id, its dates and its relations (which chat is
in which workspace), and the *length* of each name or title (AES-GCM does not hide length).

### Why column and file encryption instead of an encrypted database

Full-database encryption (SQLCipher) was considered and rejected for now:

* ChromaDB has its own SQLite file and HNSW files that SQLCipher cannot cover, so a second mechanism is needed anyway;
* SQLCipher needs a native build per platform (Windows wheels for `sqlcipher3` are not maintained), which would
  put an unverifiable binary into the Docker-free engine package;
* the sensitive content is a handful of text columns, uploaded files and chunk texts; protecting exactly those is
  simple to review and test on Linux CI, and a reader that accepts plain and protected values makes the migration safe.

The cost is the unprotected items listed above. They are listed because they are the price of this choice.

## 3. Keys

```
  Windows key store (DPAPI, per Windows user)
        │ wraps
        ▼
  data key  (32 random bytes, made once)  ──HKDF──►  "files"   key  (documents)
        │                                  ──HKDF──►  "fields"  key  (database columns, chunk text)
        │ also wrapped by
        ├─ recovery key   (256 random bits + checksum, shown once as 55 characters, never stored)
        └─ passphrase     (optional; scrypt N=2^15; replaces the key store copy)
```

* **Creation and wrapping live in the desktop app's main process** (`desktop/data-key.js`), not in the engine,
  so the same design works with the Docker engine and with the Docker-free engine. The web page never sees the
  data key; it sees the recovery key once, to show it.
* **Key store interface.** `wrap(Buffer)` / `unwrap(Buffer)` / `isAvailable()`. The real implementation uses Electron's
  `safeStorage`, which on Windows is DPAPI-protected; it refuses the Linux "basic text" fallback because that is not
  protection. A memory fake implements the same interface for tests. If no key store is available, protection cannot be
  turned on (a clear message, never a silent weaker mode).
* **Delivery.** After the engine is up, the desktop app unwraps the key and sends it to the engine
  (`POST /api/v1/system/protection/unlock`), authenticated by an HMAC of the engine's secret (the same idea as the
  local session). The engine keeps it in memory only. The environment variable `STARKLLM_DATA_KEY` does the same for
  a headless server. A restart needs no user action on the normal path.
* **Subkeys** are derived with HKDF-SHA256 per purpose; each file has its own random salt (own file key); each stored
  value has a random 96-bit nonce; the column name is authenticated data, so a value cannot be moved to another column.
* **Locked state.** If protection is on and the key has not arrived, the engine answers 423 "locked" for anything protected
  and **refuses to write** (it never falls back to plain text). The engine verifies a delivered key against a public
  fingerprint (`key_id` in `data/protection/state.json`) and refuses a different one.
* **Optional passphrase.** The data key is additionally wrapped with scrypt(passphrase), and the key store copy is removed.
  StarkLLM then asks for the passphrase at every start. (Implemented and tested in `data-key.js`; the start-up
  prompt in the app window is not built yet, see "Open points".)
* **New PC, reinstalled Windows, new Windows account:** the key store copy cannot be opened. The user enters the
  recovery key; the app unwraps the data key with it and wraps it again for the new account.

## 4. Algorithms

All from reviewed libraries; nothing home-made.

* **AES-256-GCM** (`cryptography`, Python; Node `crypto` for key wrapping). Files and backups are cut into 1 MiB chunks,
  each with a nonce that is its counter, under a per-file key; the header, the counter and a "final chunk" flag are
  authenticated, so chunks cannot be reordered, repeated, removed or cut off at the end undetected. (The same
  construction as the "STREAM" mode used by well-known file encryption tools.) Why not XChaCha20-Poly1305: AES-GCM has
  hardware support on every PC StarkLLM runs on and is in both libraries already needed; with a per-file key and counter nonces its
  nonce limits are not reachable.
* **HKDF-SHA256** for subkeys.
* **Argon2id** (`argon2-cffi`, already a dependency for passwords) for backup passphrases: 128 MiB, 3 passes, 4 lanes; the values
  are stored in the backup header and bounded when read, so a crafted file cannot ask for terabytes of memory.
* **scrypt** (Node) for the optional start-up passphrase.

## 5. Migration of existing data

`Settings > Protection > Turn on` runs this (`services/protection_migration.py`):

1. **Dry run** (`POST /system/protection/plan`): counts documents, stored texts and search entries to convert; checks that
   the key is there, that no document is being processed and that disk space is enough. It changes nothing (a test compares
   the data folder before and after).
2. A **recovery key** is created and shown once; the user must confirm that it is written down.
3. A **safety copy** of the database is written, encrypted, to `data/protection/pre-migration.db.enc`.
4. New data is protected from now on (`enabled` in `state.json`).
5. Database columns are converted in batches with compare-and-set (a row changed meanwhile is never overwritten); every
   document is encrypted to a temporary file, read back and compared with the original before the original is replaced;
   every vector collection is **copied** into a protected one and the old one is deleted (updating in place would leave
   the plain text in ChromaDB's write-ahead log).
6. The SQLite files are rewritten (`VACUUM` with secure delete) so old plain text is not left in free pages.
7. A second dry run must report nothing left; otherwise the migration counts as failed.

**Rollback.** Every reader accepts plain and protected values, so a migration can stop at any point (error, crash, power
loss) and the app keeps working; running it again continues. A failed "turn on" is rolled back automatically (everything
converted back, protection off). "Turn off" is the same engine in reverse. The safety copy of the database stays until the
user presses "Delete the safety copy". Documents are not duplicated (that would double the disk use and leave plain copies).

## 6. Encrypted backup (B7)

`Settings > Backup & Restore > Encrypted backup` (`services/backup_service.py`).

* **Format** `.starkbackup`: header (magic + version, KDF id and parameters, 16-byte salt) followed by the AES-256-GCM
  stream described above; inside, a gzip-compressed tar with the database snapshot (SQLite online backup, consistent), the
  uploads exactly as stored, the vector store, and last a `manifest.json` (SHA-256 of every file, the SHA-256 of every document's
  *content*, row count and row hash of every table, chunk count of every collection). If protection is on the backup also
  carries the data key, which is safe because the whole file is encrypted; this is what makes a restore on a new PC work.
* **Restore test**, run after every backup, on request for any file, and before every restore: the file is read to the end (every chunk
  authenticated), unpacked into a temporary folder, and compared with the manifest: file hashes, document content hashes
  (protected documents are decrypted with the key from the backup), SQLite `integrity_check`, row hashes of all tables, every protected
  column value decrypts, the vector store opens (a copy of it) and has the same number of chunks. The real data is not touched. A
  backup that fails the test right after being made is deleted and reported.
* **Refusals** with a code and a plain message: wrong passphrase (and "file changed" in the first chunk: they cannot be told
  apart, and the message says both), damaged / truncated / extended file, not a backup, newer format, weak passphrase
  (< 12 characters), documents still processing, engine locked, unsafe names inside the archive (path traversal, absolute paths).
* **Restore** stages the tested files next to the data, then swaps them in; the previous data is moved to `data/restore-undo/`,
  not deleted, until the user deletes it. If a move fails (a locked file on Windows) everything is moved back and the restore stays
  staged; the engine finishes it the next time it starts, before it opens any file.
* The old plain `.zip` backup is refused while protection is on (it would not contain the key).

### 6.1 Automatic weekly backup

`Settings > Backup & Restore > Automatic backup` (`desktop/backup-schedule.js`).

* **The desktop app drives it**, not the engine: the engine may run in a container that cannot see a USB drive, a NAS share
  or a OneDrive folder. Each run asks the engine for a backup (`/system/backup/create`, which already tests it), saves it into the
  chosen folder as `.part` and renames it when complete, sends the saved copy back to the engine for a **second restore test**
  (a faulty drive or a half-synced cloud folder is caught), and only then removes the oldest copies.
* **Safe deletion.** Only files named exactly `starkllm-YYYY-MM-DD_HH-MM[-n].starkbackup` are ever removed, never anything
  else in the folder (tested with foreign files, look-alike names and folders). The newest N (2–52, default 4) are kept; a copy that
  fails the second test is deleted and the older copies stay.
* **Passphrase.** Unattended backups need it, so it is kept wrapped by the Windows key store (the same `KeyStore` as the data key),
  never in plain text, forgotten when the automatic backup is switched off, and unreadable from another Windows account (the page then
  asks for it again). The user is told to write it down as well. Cloud-synced folders are recognised and the page says that this is fine
  because the file is encrypted.
* **Schedule and messages.** Checked at start (after two minutes) and every 30 minutes; due when the last success is 7 days old. After a
  failure the next try is in 6 hours (1 hour for a missing drive). Clear messages with a code (missing folder, not writable, disk full,
  documents still processing, locked, copy failed the test); a desktop notification only for real failures, not for a missing drive or
  a busy engine. The page shows the last success, the last error and the next due time.
* **Limits.** It uses the local session of the single-user desktop mode; with several accounts (login screen) it reports "not ready".
  The engine must be running; a backup is skipped while documents are processed.

## 7. When the key is lost

| What is lost | Result |
|---|---|
| Windows account / PC changed, **recovery key available** | enter the recovery key; all data opens. |
| Recovery key lost, Windows account still works | data opens as usual. Turn protection off and on again to get a new recovery key (this re-wraps nothing: it is a new data key and a new migration). |
| Recovery key lost **and** Windows key store lost (reinstall without the key) | **the protected data cannot be recovered by anyone.** This is the nature of encryption and is said in the dialog before turning on. Backups made with their own passphrase still open. |
| Backup passphrase lost | that backup cannot be opened by anyone. |

The Settings page and this note say so in plain words; there is no back door.

## 8. Docker-free engine

Nothing here depends on Docker. The engine only needs (a) a data folder, (b) the key from `POST /unlock` or
`STARKLLM_DATA_KEY`. The native engine package (PRs #51–#54, #61) starts the same backend and uses the same desktop code path.
The restore code moves directories inside the data folder, which works in both cases; the Docker volume case is covered by the
"locked file → finish at next start" path.

## 9. Open points

* Start-up passphrase prompt in the app window (the module and IPC exist; no screen yet).
* In the default (ChromaDB) mode the embeddings and chunk metadata are not encrypted; the encrypted search index (section 10) removes this.
* Backup of the ChromaDB files copies them while the engine runs (the encrypted index is copied with SQLite's online backup, consistent); documents still being processed block a backup, but a
  chat memory written at that very moment may or may not be in the copy. The restore test would catch a store that cannot be opened.
* Old uploads keep their readable names on disk, and the search index still carries file names and source paths in its metadata
  (see the list in section 2).

## 10. Encrypted search index

After section 2 the vector store was the largest readable part: ChromaDB keeps, in plain files, one list of 768 numbers per
piece of text (the *embedding*), and next to it the file name, page and source path. The numbers show which pieces of text are
about the same thing, and embeddings can be partly turned back into words. The owner's rule is that nothing is stored unencrypted
if it can be avoided, so StarkLLM has a second search index with nothing readable in it. It is a switch
(`state.json` `vector_mode`: `"chroma"` default, `"secure"`), so the plain mode stays available (Settings > Protection >
"Lock the search index" / "Go back to the normal search index").

### Options considered

| Option | Result |
|---|---|
| **A. ChromaDB, text encrypted** (the default since the first protection PR) | fast; vectors and metadata readable. Kept as the switchable plain mode. |
| **B. Secret rotation of every vector** (multiply by a random orthogonal matrix derived from the key, store in ChromaDB) | Distances do not change, so search is exact and as fast as A. **Rejected**: distance-preserving encryption is broken by a known-plaintext attack. The embedding model is public (`nomic-embed-text`), so an attacker embeds a few hundred known phrases ("Mit freundlichen Grüßen", a standard bank letter), pairs them with the stored vectors and solves for the rotation (orthogonal Procrustes: one SVD). After that every vector is readable again. Even without the key, the similarity structure (which letters are about the same thing) stays visible, and the metadata stays plain. It would look like protection and not be. |
| **C. Encrypted-search schemes** (searchable encryption, order-preserving, homomorphic nearest neighbour) | Orders of magnitude slower or immature for 768 dimensions; not "well-reviewed library, simple, testable". Rejected. |
| **D. Encrypt every row, search in memory** (chosen) | Row = AES-256-GCM blob; the collection is decrypted into RAM when the engine is unlocked and searched exactly with a matrix product. Nothing readable on disk. Costs memory and a load at start. |
| **E. Encrypted HNSW graph files, decrypted into RAM** | Faster search for more than about 1 million pieces of text; more code, approximate answers. Not needed at the size of a household archive (see the numbers); the route to take if an archive ever outgrows D. |

### Design of D (`services/secure_index.py`)

* **One SQLite file**, `data/secure_index/index.db`. Tables `collections` and `rows` only. Every value is a blob: nonce (12 bytes) +
  AES-256-GCM(ciphertext) with a key from HKDF(data key, "vectors"). The payload of a row is the id, the text, the metadata and the vector
  (float32); the **authenticated data** of the blob is the collection key plus the row key, so a row cannot be edited, copied into another
  row or moved to another collection without detection (test: swapped rows and flipped bytes raise `CorruptData`).
* **Keys in the file are HMAC-SHA256** (key from HKDF(data key, "vectors-index")) of the collection name and of the row id. The file
  shows neither "user_3_workspace_12" nor "chunk-77".
* **Write-through, crash safe.** Every `add`, `upsert`, `update`, `delete` is one SQLite transaction with `synchronous=FULL`; the
  in-memory copy changes only after the commit; if a write fails halfway the collection is reloaded from the file (test: a simulated
  power loss in the middle of a three-row upsert leaves the old state, in the file and in memory). Deleted rows are overwritten
  (`secure_delete`), and the file is rewritten (`VACUUM`) after 5,000 deletes, when a collection is deleted, and after a migration.
* **Same API as the ChromaDB code uses** (`add`, `upsert`, `update`, `get`, `query`, `delete`, `count`, `modify`, `where` with `$eq $ne $in $nin
  $gt $gte $lt $lte $and $or`, `where_document` with `$contains $not_contains $and $or`, `limit`/`offset`, `include`), checked against a real
  ChromaDB with the same inputs in `tests/test_secure_index.py` (ids, order, texts, metadata and distances equal; cosine, L2 and inner
  product; equal distances may come in another order). Filters on one field (`source`, `document_id`, `workspace_id`) use an in-memory
  hash index, built on first use.
* **Search** is exact brute force with numpy: distance = 1 − cosine (or squared L2, as ChromaDB reports it), best *k* by `argpartition`.
* **Memory.** The matrix is float32 (exact). Above 1,000,000 vectors in one collection it is kept as float16 (half the memory, search about
  14 times slower because the matrix is converted back to float32); this is a safety valve and is not meant to be used (see the numbers).
* **Locked engine.** Without the key every access raises `ProtectionLocked` (HTTP 423), as for the other protected data; nothing is written in plain.
* **Switching** (`protection_migration.run_vectors`): dry run first (collections, pieces of text, key, documents busy); every ChromaDB
  collection is copied (text decrypted, vectors and metadata as they are), counts are compared, rows written during the copy are
  copied in a second pass; then the **switch** (`vector_mode = "secure"`, written atomically); then the ChromaDB collections are deleted
  and its SQLite file is rewritten, so the vectors and metadata are gone from the disk (test: no file name, path or float bytes
  of a known vector remain in the ChromaDB folder). Stopping at any point is safe: before the switch the old index is in use and a new
  run starts the copy again; after the switch a new run only finishes the clean-up and never copies over the encrypted index.
  The way back is the same in reverse (text sealed again). **Turning protection off moves the index back first**, because the
  encrypted index only exists while protection is on.
* **Backup and restore.** The backup contains `secure/index.db` (a consistent copy made with SQLite's online backup, still
  encrypted) and the number of rows of every collection. The restore test decrypts and authenticates **every row** with the key from the
  backup and compares the counts. A restored backup brings its own `vector_mode`.

### Measured speed, recall and memory

Linux container, 16 cores, 768-dimensional vectors (the size of `nomic-embed-text`), cosine, texts of about 270 characters and four metadata fields per piece
of text, single query at a time, top 10. "Clustered" data is a mixture of 60 Gaussians (like topics), "random" is Gaussian noise (the
worst case for approximate search). Recall is measured against an independent exact search in numpy. Script: `backend/tools/bench_secure_index.py`.
Loading and searching are measured in a fresh process, as after a restart of the engine.

| Pieces of text | Data | Search p50 / p95, ChromaDB | Search p50 / p95, encrypted index | Recall@10 ChromaDB (HNSW) | Recall@10 encrypted (exact) | With a filter (1/5 of the documents), encrypted | Insert per second, ChromaDB / encrypted | Load at start, encrypted | Memory, encrypted (whole process delta) | File size, ChromaDB / encrypted |
|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | clustered | 0.7 / 1.0 ms | 0.5 / 0.7 ms | 0.9995 | 1.0 | 1.0 ms | 3,400 / 29,700 | 0.15 s | 44 MB | 54 / 40 MB |
| 10,000 | random | 1.4 / 1.7 ms | 0.5 / 0.7 ms | 0.68 | 1.0 | 1.1 ms | 2,900 / 29,100 | 0.14 s | 44 MB | 54 / 40 MB |
| 100,000 | clustered | 1.2 / 1.4 ms | 7.0 / 13.7 ms | 0.99 | 1.0 | 15 ms | 2,400 / 22,700 | 1.5 s | 410 MB | 507 / 400 MB |
| 100,000 | random | 1.9 / 2.3 ms | 7.1 / 20.3 ms | 0.23 | 1.0 | 15 ms | 1,700 / 23,000 | 1.5 s | 410 MB | 506 / 400 MB |
| 500,000 | clustered | not measured | 35 / 53 ms | not measured | 1.0 | 87 ms | not measured / 18,300 | 8.9 s | 2.0 GB | not measured / 2.0 GB |

Also measured: reading all pieces of text of one document (`get` by source path) takes 0.07 ms at 10,000, 0.7 ms at 100,000 and 4.9 ms at
500,000 pieces of text. With float16 memory at 500,000 pieces of text (the safety valve) a search took about 500 ms (recall 0.998), roughly
14 times slower than float32, which is why float32 is used up to 1,000,000.

Conclusions: the encrypted index is **exact** (recall 1.0), **9 to 10 times slower per search** than ChromaDB at 100,000 pieces of text
(7 ms instead of 1 ms: invisible next to the language model, which needs seconds), **faster to write** (the encrypted blob is a single row), and
needs **about 4 MB of memory per 1,000 pieces of text**. At 500,000 pieces of text, far beyond a household archive, a search takes 35 ms.
ChromaDB's recall on clustered data is high; on unstructured data at 100,000 pieces it finds only a quarter of the true neighbours, so exactness is
also a quality gain. (Synthetic numbers: real documents lie between "clustered" and "random".)

How to read this: a household with a few thousand letters has 10,000 to 50,000 pieces of text; searching takes a few milliseconds
either way, and the encrypted index is always exact. ChromaDB's approximate search finds fewer of the true nearest neighbours as the
archive grows (a quality loss that users never see, because the reranker and the other retrieval steps follow). The cost
of the encrypted index is memory (about 410 MB per 100,000 pieces of text in total, of which the vectors are 307 MB) and a load of
about 1.5 seconds per 100,000 pieces of text when the engine starts or the first question comes in after unlocking.

### What still leaks

With the encrypted index on, a person who copies the data folder can see:

* that the file `index.db` exists, its size, and when it last changed (so roughly when documents were added);
* how many rows each collection has (not the names: they are hashed), and the size of each row (roughly the length of the text and the number of
  metadata fields), because blobs are not padded;
* nothing about content, names, paths, pages or topics.

A running, unlocked StarkLLM holds everything in memory in plain form (the matrix, the texts, the metadata); a program running as the same
Windows user, or a memory dump while the app runs, sees it. An attacker who can **write** to the file can delete rows or put back an older
copy of the whole file (each row is authenticated, the file as a whole is not versioned); they cannot forge or edit rows. The temporary decrypted
copy of a document that is being read (`data/tmp`) and the operating system's swap file are outside this design (BitLocker covers them).
Access patterns (which collection is opened when) are visible to anyone watching the running process.

### BitLocker and device encryption

Settings > Protection shows a short recommendation, in plain language, to also turn on Windows drive encryption (BitLocker, or "Device
encryption" on many PCs). It covers what StarkLLM cannot: file names and chat titles, the programs and models, the swap and hibernation files,
and traces of plain files deleted before protection was turned on.

## 11. Manual test on a real Windows PC

DPAPI and the in-app flow cannot be tested on Linux CI. Before a release that contains this:

1. Fresh install, open Settings > Protection. It says protection is off. **Turn on protection**: a recovery key appears; the
   "Continue" button stays grey until the checkbox is ticked.
2. Upload a PDF, a photo and a Word file *before* turning on; chat a bit. Turn on. The progress shows, the page ends with "Done".
3. In `%APPDATA%\StarkLLM\data\uploads` open a document with Notepad: unreadable. Open the chat in the app: readable.
4. Search a word from a letter in the global search and in the chat search: results still appear. Open a document's preview and download: readable and identical to the original.
5. Quit StarkLLM completely, start it again: no prompt, everything opens.
6. Sign in to Windows as **another user**, try to open the first user's data folder or run StarkLLM there: nothing readable.
7. `%APPDATA%\StarkLLM\protection` contains `data-key.wrapped` and `data-key.recovery.json`, and no 32-byte plain key.
8. Make an encrypted backup to a USB stick; the page says "Restore test passed". Open the `.starkbackup` file in a hex viewer: no readable text.
9. Try the backup with a wrong passphrase (refused), with one byte changed in a hex editor (refused), with the file cut in half (refused).
10. **Restore on another PC** (or a second Windows account): install StarkLLM, Restore the file with the passphrase. A new recovery key is shown; all documents open.
11. Windows account password change / reset: the app still starts (DPAPI follows password changes; after an *admin reset* use the recovery key).
12. Turn off protection: documents open in Notepad again (plain), chats still work.
13. Kill StarkLLM from the Task Manager in the middle of "Turn on", start it again: everything opens; run "Turn on" again: it finishes.

Encrypted search index (section 10), additionally:

14. Settings > Protection > "Lock the search index": the confirmation shows the numbers, the page ends with "The search index is locked." Ask a question about a letter: the answer still cites the right page, and the time to answer is not noticeably longer.
15. Open `%APPDATA%\StarkLLM\data\chroma\chroma.sqlite3` and `data\secure_index\index.db` in a hex viewer / `strings`: no file names, paths, words from letters, or collection names.
16. Quit and start again: the first search after the start is a little slower (the index is loaded into memory); Task Manager shows the engine using about 400 MB more per 100,000 pieces of text.
17. "Go back to the normal search index" and lock again: documents and answers are unchanged.
18. Make an encrypted backup while the index is locked, restore it on another PC: the restore test passes and the search works after the restore.
19. Windows file locking: lock the index on a PC with an antivirus that scans new files; the index file must not be reported as locked or quarantined (SQLite file in WAL mode with `-wal` and `-shm` next to it).
20. Settings shows the BitLocker / device-encryption recommendation; the link target text matches the Windows version (Windows 11 Home: "Device encryption"; Pro: "BitLocker").
Automatic backup (section 6.1), additionally:

21. Automatic backup: choose a USB stick, turn on with a passphrase; "Back up now" shows "tested". Pull the stick out, run again: the "drive connected?" message appears and no notification pops up; put it back: the next run succeeds.
22. Put other files (and an old `starkllm-...` file with a different name) into the folder, set "keep 2", run three backups: only the oldest StarkLLM backup is removed, your other files are untouched.
23. Choose a OneDrive folder: the page says the folder is synced and that this is fine; the `.starkbackup` file appears online and cannot be read there.
24. Sign in as another Windows user (or copy the `protection` folder): the saved passphrase cannot be read and the page asks for it again.
