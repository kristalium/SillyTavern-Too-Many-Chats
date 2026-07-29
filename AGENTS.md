# Too Many Chats — agent notes

SillyTavern extension: proxy chat-list UI (folders, pins, activity sort,
branch families, cards browser, bulk ops) rendered over ST's native
"Manage chat files" popup. Single IIFE in `index.js`; no build step.

## Gate — run before every push, in this order

```bash
cp index.js /tmp/tmc_gate.mjs && node --check /tmp/tmc_gate.mjs   # 1. ESM parse (never check the .js directly)
node test_tmc.mjs                                                  # 2. full suite; exit 1 on any failure
```

Test deps (`jsdom`, `jquery`) install via `npm i jsdom jquery`; `node_modules`
and `package*.json` stay untracked.

Rules that have bitten before:
- `test_tmc.mjs` extracts top-level functions from the real source by brace
  counting and sandboxes them with `new Function`. **Any new top-level
  function referenced by a sandboxed function must be added to that test's
  extraction list**, or the ReferenceError may be silently swallowed by
  in-code try/catch and surface as an unrelated assertion failure.
- Every new guard gets a **negative test**: reintroduce the bug in a scratch
  copy (`cp`-restore, NOT `git checkout` — a scratch tree's `.git` restores
  the *committed* file, not your working state) and confirm the matching
  assertion fails with exit 1.
- Stamp discipline: `manifest.json` version == header comment stamp == init
  log stamp. The suite enforces this ([48]); drift is a gate failure.
- Version bump on every push; README changelog updated with every change.

## Verified runtime contracts (checked against SillyTavern source, Jul 2026)

- Current ST search **re-fetches `/api/chats/search` per keystroke and
  REBUILDS every native block** (`$('#select_chat_div').empty()` + re-append).
  It does NOT toggle `display` on existing blocks — that was older builds.
  Consequence: element identity is not a valid cache key on its own;
  `reuseCachedNative()` adds a `textContent` signature. Keep both paths.
- Block template: everything (title `.select_chat_block_filename`, preview
  `.select_chat_block_mes`, date `.chat_messages_date`, size
  `.chat_file_size`, count `.chat_messages_num`, rename/export/delete
  buttons) lives INSIDE `.select_chat_block`, so `innerHTML` proxy copies
  carry the buttons. Native button handlers are document-delegated jQuery —
  the proxy click handler's `stopPropagation()` is load-bearing (without it a
  copied `.renameChatButton` reaches ST's delegate with no
  `.select_chat_block_wrapper` ancestor and renames an empty string).
- `file_name` attr / `/api/chats/search` `file_name` / `/recent` `file_id`
  carry **no `.jsonl`** on current ST; older builds included it. Anything
  persisted compares through `normalizeChatId()` — no exceptions.
- `CHAT_RENAMED` event: `{ avatarId, groupId, oldFileName, newFileName }`
  (names WITH `.jsonl`), emitted from every rename path. Migration lives in
  `migrateChatRename()` (pure) + the init subscriber. Feature-detected.
- `/api/chats/recent` items: `file_id`, `avatar` (solo) / `group` (groups),
  `mes`, `chat_items`, `chat_metadata` (when `metadata: true`).
- Imports used (all verified exports): `script.js` →
  `deleteCharacterChatByName(idx, nameNoExt)` (appends `.jsonl` itself),
  `openCharacterChat(nameNoExt)`, `selectCharacterById(idx)`;
  `group-chats.js` → `deleteGroupChatByName`, `openGroupById`,
  `openGroupChat`.

## Invariants (do not regress)

- One canonical cleanup for chats leaving a card: `stripDeletedFromFolders`
  (folders + pin + stamp, normalized both sides). Bulk delete and
  move-to-card both use it.
- Visibility is decided ONCE upstream in `performSync` (`visibleData`);
  clustering, distribution, and counts all consume that list.
- Pins order via `partitionPinned` — never unshift-per-pin (inverts order).
- Two observers, two variables (`mutationObserver` / `lazyObserver`) — never
  merge them (v0.7.0 root fix).
- `.tmc_ctx` is `position: fixed`: client coordinates + `clampMenuToViewport`
  after append. Menus must always land fully on-screen.
- Main-view 3-row folder truncation is applied via `endIndex` in
  `renderBatch` — never render-then-delete.
- Model-agnostic and ST-build-agnostic: every new-API use is
  feature-detected with graceful fallback; no hardcoded model identity.

## Push workflow

Edits via Python exact-string replacement with `count==1` asserts (bad
anchors caused the 0.12.1 breakage — the assert is the guard). Then gate,
then commit, then `git ls-remote origin HEAD` before and after push to
verify the remote actually moved.
