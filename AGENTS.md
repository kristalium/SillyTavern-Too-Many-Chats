# Too Many Chats — agent notes

SillyTavern extension: proxy chat-list UI (folders, pins, activity sort,
branch families, cards browser, bulk ops) rendered over ST's native
"Manage chat files" popup. Single IIFE in `index.js`; no build step.

## Gate — run before every push, in this order

```bash
cp index.js /tmp/tmc_gate.mjs && node --check /tmp/tmc_gate.mjs   # 1. ESM parse (never check the .js directly)
node test_tmc.mjs                                                  # 2. full suite; exit 1 on any failure
python3 negtest.py                                                 # 3. negative gate; must report N/N proven
```

`negtest.py` is the standing negative gate: for every fix in the release it
copies the tree to a scratch dir, reintroduces the ORIGINAL bug, and requires
both a non-zero exit AND the specific assertion written for that bug to be the
one that fails. Add a case to it for every new guard. It asserts on the named
assertion, so renaming an assertion string breaks it loudly — that is intended.
Note it distinguishes "the guard fired" from "the suite crashed": a
ReferenceError also exits 1 but is not proof of anything.

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

- **The chat popup's scroll container is `#tmc_proxy_root`** (TMC's own
  stylesheet gives it `overflow-y: auto`). `#shadow_select_chat_popup` is
  `height: 100vh` with no overflow and NEVER scrolls; `#select_chat_div` is
  ST's scroller but TMC parks it off-screen and the proxy tree is its sibling,
  not its child. There is no `.shadow_select_chat_popup_body` or
  `#select_chat_popup_body` in any ST build — both were invented. One
  resolver, `getScrollContainer()`, serves scroll preservation and the
  IntersectionObserver root; never re-guess this per call site.
- **ST's two delete paths are NOT equivalent.** `.PastChat_cross` ->
  `handleDeleteChat` -> `delChat` calls `replaceCurrentChat()` when the file
  being deleted is the loaded chat. `deleteCharacterChatByName()` only calls
  `updateRemoteChatName()` — it repoints `characters[id].chat` and leaves the
  deleted chat in memory with its own `chat_metadata.integrity`. Same shape for
  groups: `deleteGroupChat()` clears metadata and jumps, `deleteGroupChatByName()`
  only rewrites `group.chat_id`. Never point either *ByName helper at the open
  chat; route it through `replaceCurrentChat()` / `deleteGroupChat()`.
- `chat_metadata.integrity` is a per-file uuid minted on load. The server
  (`trySaveChat`) rejects a save whose token disagrees with the token already
  in the target file, and SKIPS the check when the target has no token or when
  `force` is set. So `force: true` disables the only server-side guard against
  clobbering an unrelated chat — a copy must mint its OWN token instead.
- `/api/chats/save` runs the destination through `sanitize()`, so a name chosen
  from a `/api/chats/search` listing is a guess, not a fact. `/api/chats/get`
  goes through the same resolution and is the authoritative existence probe.
- ST's popup header holds four `<input>` elements from the hidden chat-import
  form BEFORE `#select_chat_search`. They currently escape
  `input[type="text"]` only because they carry no `type` attribute at all.
  Locate the search box by its id (`findSearchInput()`), never positionally.
- `event_types.CHAT_DELETED` ('chat_deleted') and `GROUP_CHAT_DELETED`
  ('group_chat_deleted') fire for deletes that bypass TMC entirely; both carry
  the chat name without extension.
- The native date cell is `timestampToMoment(last_mes).format('lll')` — a
  LOCALE-DEPENDENT string. `Date.parse` of it returns NaN on non-English
  installs. `resolveBlockDate()` owns the fallback chain and never returns NaN
  (NaN poisons `Math.max` and makes comparators return NaN).
- FontAwesome may run in SVG-with-JS mode, replacing every `<i>` with `<svg>`.
  `element.className` is then an `SVGAnimatedString`, not a string — truthy,
  and `.split()` on it throws. Read `classList`.

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
- Search is a TRANSIENT LENS: while a term is active, sections holding
  matches render forced-open (display + chevron) but the persisted
  collapsed flag is never written; hide-empty applies in main/family modes
  only — NEVER in folder view, whose single section header holds the Back
  button. Continuation batches (sentinel) always pass `lastSearchTermSeen`.
- Model-agnostic and ST-build-agnostic: every new-API use is
  feature-detected with graceful fallback; no hardcoded model identity.
- Highlighting is a DOM operation, never an HTML string: `splitHighlight()`
  (pure) + `applyHighlight()` (builds text nodes and `.tmc_hl` spans). Do not
  reintroduce an escape-then-inject path — its safety depended on call-site
  ordering, and its regex ran over escaped entities.
- Header toggle state (Cards / Families / Select / sort) is painted ONLY by
  `refreshHeaderState()`, from real state, every sync. Buttons must never
  store or self-paint their own state: the popup markup outlives a close, so
  anything painted at creation drifts.
- One implementation per operation: `moveChat()` delegates to `moveChats()`;
  bulk paths never loop the single-item helper (N settings writes, N renders,
  each resetting the other's debounce).
- Every class the JS applies must have a rule in `style.css` — gate [59]
  enforces it. A class set in JS and styled nowhere is an invisible feature.
- Presentation lives in `style.css`, not in `element.style.cssText`.

## Push workflow

Edits via Python exact-string replacement with `count==1` asserts (bad
anchors caused the 0.12.1 breakage — the assert is the guard). Then gate,
then commit, then `git ls-remote origin HEAD` before and after push to
verify the remote actually moved.
