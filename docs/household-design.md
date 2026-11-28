# Shared household workspaces — design

Status: **implemented (2.8, option 12), needs a manual test on Windows with several accounts.**

Several accounts on one PC (the login screen) can share the letters of a household. Everything else stays private.

## 1. What it does

* One account creates a **shared workspace** ("Our home") in *Shared workspaces* (the people icon next to
  "Workspace" in the sidebar) and invites other accounts **of this PC** by their account name. The invited account
  sees the invitation there (the icon shows a number) and accepts once, or declines. Before it accepts it sees nothing.
* **Members** see the workspace's letters, the inbox, the deadlines and the cases; they add documents, mark letters
  and deadlines done, choose how to read an ambiguous date, and ask questions about the letters.
* **Roles.** The owner invites, removes members (or withdraws an invitation) and deletes the workspace. A member can
  only leave. A member deletes only documents they added; the owner deletes any. Renaming the workspace, its
  instructions and its knowledge-base folder choice stay with the owner.
* **Who did it.** Every action is recorded with the account that did it: the deadline list shows "Marked done by
  Anna", the inbox shows "Added by Ben" and "Marked done by Anna", and *Who did what* lists the whole trail (created,
  invited, joined, declined, left, removed, document added or deleted, marked done or new, title or case changed,
  deadline done or taken back, date reading chosen, key made or replaced).
* **A paired phone** uses its account's session, so it sees the shared workspace with exactly that account's rights
  (and loses it when the account leaves or is removed). The Android app needs no change: the workspace list and the
  deadlines simply contain the shared workspace.

## 2. What is shared, what is private

| Shared (the household's) | Private (each account's own), also inside a shared workspace |
|---|---|
| the documents and their search index | chats, their messages and titles |
| inbox decisions: done / new, own title, case | chat folders |
| the reading of an ambiguous date | the memories learned from chats (kept per account and workspace) |
| "done" marks of deadlines | reminders ("remind me 3 days before") |
| the activity trail | the knowledge base (a member asks with their own knowledge base) |
| | every private workspace |

Shared decisions are stored under the **owner's** account id with the acting account in `actor_id`, so the inbox and
the deadline list read them like the owner's own and every member sees the same state.

**Leaving or removal.** The member loses access at once: the workspace disappears from their list, the API answers
404 for its documents, chats, activity and index. Their private chats, chat folders, memories and reminders in that
workspace are deleted (nobody else could read them anyway). **Deleting** the workspace (owner only) deletes the
letters and every member's chats in it.

## 3. Access rules (code)

All checks go through `services/household.py`:

* `ws_visible(user)` — own workspaces and the shared workspaces the account has **joined** (an invitation is not enough);
  every workspace check in the engine uses it (`deps.get_workspace_or_404`, documents, dashboard, search, studio,
  other apps and MCP).
* `chat_visible(user)` / `chat_owned(ws, user)` — only the account's own chats (`chats.user_id`; older rows without it
  belong to the workspace owner). The chat, message, folder, search and summary endpoints use it.
* `decisions_visible(model, user)` — own decisions plus the decisions about documents of shared workspaces the account sees.
* `storage_owner(ws, user)` — the search index of a shared workspace is named after its owner
  (`user_<owner>_workspace_<id>`); an account that does not see the workspace gets its own (empty) name, never the owner's.

## 4. Encryption (with protection at rest on)

```
  PC data key (Windows key store, docs/encryption-design.md)
      │ HKDF "account-keys"
      ▼
  account key of each account  (32 random bytes; table account_keys, AES-256-GCM, account id authenticated)
      │ wraps (AES-256-GCM, "workspace / version / account" authenticated)
      ▼
  workspace key of a shared workspace, one per version  (table workspace_keys: one wrapped copy per member)
      │ HKDF "files"
      ▼
  the workspace's document files  (SLLMENC; the key id in each file's header says which key opens it)
```

* The shared workspace gets its **own data key**, wrapped for **each member's account key**. A member opens it with
  their own wrapped copy and their own account key (`household.workspace_key`); an account without a copy gets
  `NoAccess`. A copy only opens for the account and version it was made for.
* New documents of a shared workspace are written with the workspace's files key (`vault.open_write(path, workspace_id)`).
  Reading picks the key by the key id in the file header (`vault._read_key`), so every reader (preview, download,
  indexing, OCR, backup) works unchanged. The unwrapped keys are kept in memory only and are forgotten when the
  engine is locked.
* **Removal rotates the key.** When a member leaves or is removed, their wrapped copies are deleted at once; then a
  new version of the workspace key is made, wrapped for the remaining members only, and every document file of the
  workspace is encrypted again with it (`rekey_files`; each file is written to a temporary copy, read back and
  compared before it replaces the original, as in the protection migration). The old version is deleted when no file
  needs it any more. Cost: reading and writing every document of the workspace once, in the background — for a
  household (hundreds of letters, some hundred MB) seconds to a minute. If a file cannot be replaced (locked by
  another program, crash), the old version stays until the next upload into the workspace finishes the job.
* Accepting an invitation, or removing an active member, needs the unlocked engine (423 otherwise): no member is ever
  without a wrapped copy, and no removal skips the key replacement.
* **Backup and restore.** The keys travel in the database inside the encrypted backup. The restore test opens the
  documents of shared workspaces with the backup's own data key (`household.file_keys_from_database`).
* Protection turned off and on again makes a new PC data key: account keys wrapped with the old one are replaced on
  first use, and the workspace gets a new key version (turning protection off decrypted every file, so nothing is lost).
  Documents that were in a shared workspace **before** protection was turned on are protected with the PC key by the
  migration and move to the workspace key in the background at the next upload into that workspace.

### What this protects, honestly

All accounts of a PC share one engine and one PC data key, and the account keys are wrapped with that PC data key. So:

* **Against another account on the same PC, the separation is enforced by the engine's access checks**, exactly as
  for private workspaces today; the key hierarchy does not add a cryptographic barrier between accounts of one PC,
  because the engine (which holds the PC data key while unlocked) can unwrap every account key. Private workspaces stay
  private by the same checks; the tests check every path.
* What the workspace key does give: membership is a fact at rest (a member without a wrapped copy cannot open the
  workspace's files with the engine's key-by-member function), a removed member's copies are gone, and after the key
  replacement the old key opens nothing written since and none of the existing files. A copy of the data folder made
  before the removal still opens with the PC data key, as all protected data does (encryption-design.md, section 1).
* **Not under the workspace key** (they stay protected with the PC key, as before): the text of the search index (chunk
  texts and, in the encrypted search index, the whole rows), document names and other protected columns, the inbox
  decisions, the layered summaries, and the activity trail. Moving them under the workspace key would need a second
  key path in the column type and in both search indexes; this was not done at this stage. They are not readable
  without the PC data key either.
* Real separation **between Windows users** stays as it is: each Windows user has their own StarkLLM data folder and
  key; shared workspaces work only between accounts of one StarkLLM installation (one Windows user).

## 5. Tests

`backend/tests/test_household.py`: invitation and acceptance (by name, once, decline, refusals); access rules
(members see shared letters, never private ones, in inbox, deadlines, documents, search and index; roles; a removed
member and a member who left lose access, also on a paired phone); the "who did it" trail; private chats (list,
read, rename, delete, post, folders, search, memories per account); encryption (key wrapped per member, decryption per
member, shared documents use the workspace key, the PC key alone does not open them, locking forgets the keys, the
restore test finds the keys, removal replaces the key and re-encrypts the files, a late joiner gets a copy, a locked
engine refuses).

## 6. Manual test on Windows (before the release)

1. Two accounts on one PC (Anna, Ben). Anna: *Shared workspaces* > create "Our home", invite "ben". Ben signs in:
   the icon shows 1; accept. "Our home" appears in Ben's workspace list with the people icon.
2. Anna uploads a bill to "Our home"; Ben sees it in the inbox ("Added by Anna") and in the deadlines; Ben marks the
   deadline done; Anna sees "Marked done by Ben". *Who did what* lists both.
3. Both chat in "Our home": neither sees the other's chats, also not in the global search.
4. Ben's paired phone shows "Our home" and its deadlines.
5. With protection on: open a document of "Our home" in `%APPDATA%\StarkLLM\data\uploads` with a hex viewer: not
   readable. Anna removes Ben: Ben's list, inbox and phone no longer show it; the documents still open for Anna;
   *Who did what* shows "The workspace key was replaced".
6. Encrypted backup and restore test with a shared workspace: "Restore test passed".
