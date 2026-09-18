/**
 * Too Many Chats - SillyTavern Extension
 * Chat organization and stuff
 * v0.16.0 - Fail-safe + robustness pass: bulk delete can no longer fail
 *           silently (zero deleted is an explicit error; the native-button
 *           fallback no longer counts unconfirmed clicks as deleted), the
 *           content cache is larger than the 30-row search render slab (no
 *           guaranteed LRU thrash — and its re-downloads — per keystroke),
 *           fetches in flight when a message lands can't write stale content
 *           back into the cache, transient fetch failures retry after 30s
 *           instead of poisoning previews for the whole session, and the
 *           native chat list is only hidden once a proxy render has actually
 *           succeeded (the body.tmc-live gate in style.css).
 * v0.15.0 - Chat rows now lead with the BEGINNING of the last message (ST's
 *           /api/chats/search preview is the message TAIL — '…' + final 400
 *           chars — which is what every row used to show), and a chat opened
 *           from the list loads exactly once (the forwarded native click and
 *           the proxy's own bubble both reached ST's document-delegated
 *           opener: double "Chat History — Loading chat…" banner, double load)
 * @original author - chaaruze
 * @picked up by - Kristalium
 */

(function () {
    'use strict';
    console.warn('[TMC] Script Parsed & Executing Top Level IIFE');

    const MODULE_NAME = 'chat_folders';
    const EXTENSION_NAME = 'Too Many Chats';

    const defaultSettings = Object.freeze({
        folders: {},
        characterFolders: {},
        pinned: {},
        lastActive: {},
        familyView: false,
        familyCollapsed: {},
        showRecent: true,
        sortOrder: 'activity-desc',
        version: '1.1.0'
    });

    // v0.7.0 ROOT FIX: these were previously a single shared `observer` variable.
    // initIntersectionObserver() runs on EVERY performSync and started with
    // `observer.disconnect()` — which disconnected the *MutationObserver* and
    // overwrote it with the IntersectionObserver. Net effect: after the first
    // render, no DOM mutation (new blocks, native deletions, popup visibility,
    // ST's search filtering) ever triggered a resync again; the extension was
    // limping along on the 500ms heartbeat alone. Two observers, two variables.
    let mutationObserver = null; // watches ST's native DOM for changes
    let lazyObserver = null;     // IntersectionObserver for infinite scroll sentinels
    let observedPopupNodes = []; // popup nodes the mutationObserver is attached to (v0.8.1)
    let syncDebounceTimer = null;
    let bulkMode = false;
    let selectedChats = new Set();
    let currentView = 'main'; // 'main' | 'folder'
    let viewFolderId = null;
    let chatsByFolder = {}; // Memory store for lazy loading
    // v0.8.0: default is 'activity-desc' — true recency by file modification
    // order, matching ST's welcome-screen Recent list. The old default
    // ('date-desc') sorts by the send_date of the LAST MESSAGE in the file,
    // which makes a fresh branch of an old chat sink to the bottom next to
    // its parent (branching copies old messages verbatim). Two different
    // clocks; this is the one users actually mean by "recent".
    // Persisted in settings; loaded in init().
    let sortOrder = 'activity-desc';
    const BATCH_SIZE = 20;
    let lastSelectedChat = null; // Track last clicked for shift-select
    // v0.11.0: without these, ANY background re-sync (native mutation, branch
    // fetch completing) rebuilt every section at the initial batch size and
    // reset the popup scroll — scrolling a long list felt like it "snapped
    // back". Both persist for the popup-open session.
    let renderedCounts = {};  // section id -> items already rendered
    let lastScrollTop = 0;
    let lastSearchTermSeen = '';
    // v0.14.0: identity of the list currently on screen (character, view,
    // folder, family/flat, search term). Scroll position is only worth
    // restoring across a rebuild of the SAME list; a different list should
    // start at the top, which is what the user expects and what the old
    // (dead) code accidentally always did.
    let lastListIdentity = '';
    let lastSyncedCharacterId = null; // Track which character the proxy tree currently reflects

    // ========== SEARCH CONTEXT PREVIEW ==========
    // Cache of fetched chat content. v0.8.1: two structural fixes here.
    // (1) SCOPE: keys are now `${characterKey}::${fileName}` — fileName alone
    //     is only unique per character, so two characters with a chat named
    //     "New Chat" used to share (and cross-contaminate) a cache entry.
    // (2) BOUND: the old comment promised the cache was "cleared if it grows
    //     too large" but no clearing code existed. Whole multi-MB chats
    //     accumulated for the lifetime of the page — real jank on Android.
    //     Now a small LRU: least-recently-used entries are evicted.
    // v0.16.0: 24 was SMALLER than the search-mode render slab (30 rows,
    // see performSync) — rendering 30 rows through a 24-slot LRU evicted
    // the first 6 keys mid-pass, so the next keystroke re-downloaded them
    // in full (up to ENRICH_MAX_BYTES each). Steady state was ~6 full-chat
    // fetches PER KEYSTROKE for the whole search, exactly the jank this
    // cache exists to prevent. The cap must stay ≥ the slab size.
    const CONTENT_CACHE_MAX = 48;
    let chatContentCache = {};
    let contentCacheOrder = []; // LRU order, oldest first
    // In-flight fetches (same keying), to dedupe concurrent requests.
    let chatContentPromises = {};
    // v0.16.0: cache generation. Bumped by invalidateChatContentCaches()
    // when the open chat's content changed. A fetch that was in flight at
    // that moment holds the old generation and must NOT write its (now
    // stale) result back into the cache — clearing the maps alone did not
    // stop that write-back, which re-poisoned the cache with pre-turn
    // content until the next message event.
    let contentCacheGeneration = 0;
    // v0.16.0: a FAILED fetch used to be cached as [] FOREVER (and as '' in
    // beginningPreviewCache), so one network hiccup killed that chat's
    // previews for the whole session. Failures are still cached (to bound
    // retry traffic), but only for this long — after it, the entry reads
    // as a miss and the network gets another chance.
    const CONTENT_ERROR_RETRY_MS = 30000;
    let chatContentErrAt = {}; // key -> timestamp of the last FAILED fetch

    function contentCacheKey(fileName) {
        return String(getCurrentCharacterId() ?? '?') + '::' + fileName;
    }

    function touchContentCache(key) {
        const i = contentCacheOrder.indexOf(key);
        if (i > -1) contentCacheOrder.splice(i, 1);
        contentCacheOrder.push(key);
        while (contentCacheOrder.length > CONTENT_CACHE_MAX) {
            const evicted = contentCacheOrder.shift();
            delete chatContentCache[evicted];
            delete chatContentErrAt[evicted]; // error stamps never outlive their cache entry
        }
    }

    // v0.15.0: beginnings of last messages, keyed like the content cache.
    // Stored separately so re-renders apply the beginning SYNCHRONOUSLY —
    // deriving it through the (async) fetch cache on every render would flash
    // the native tail text on each sync. '' marks known-empty/failed, so a
    // chat with no usable text is not refetched on every sync either.
    let beginningPreviewCache = {};
    // Cache of parsed native chat-block data (dates, sizes, html, etc.), keyed
    // by fileName -> { element, ... }. Avoids re-parsing every native block
    // (regex date/size extraction, full innerHTML copy) on every sync, which
    // otherwise runs once per keystroke while the search box is focused.
    // Invalidated automatically per-entry when the underlying element changes
    // (see the `cached.element === block` check in performSync).
    let nativeDataCache = {};
    // Helper to clear selection
    function clearSelection() {
        selectedChats.clear();
        bulkMode = false;
        updateBulkBar();
        scheduleSync();
    }

    // ========== STYLES ==========
    // Extended to support raw hexes in logic
    const FOLDER_COLORS = {
        'red': '#ff6b6b',
        'orange': '#ffa94d',
        'yellow': '#ffec99',
        'green': '#69db7c',
        'blue': '#4dabf7',
        'purple': '#b197fc',
        'pink': '#fcc2d7',
        'default': 'transparent'
    };
    let userOpenedPanel = false;  // Track if user intentionally opened the panel

    // ========== SETTINGS ==========

    function getSettings() {
        const context = SillyTavern.getContext();
        const { extensionSettings } = context;

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }

        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
                extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
            }
        }

        return extensionSettings[MODULE_NAME];
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    // ========== HELPERS ==========

    function generateId() {
        return 'folder_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    }

    function getCurrentCharacterId() {
        const context = SillyTavern.getContext();
        // Group Chat Support
        if (context.groupId) {
            return context.groupId;
        }
        if (context.characterId !== undefined && context.characters[context.characterId]) {
            return context.characters[context.characterId].avatar || context.characters[context.characterId].name;
        }
        return null;
    }

    // v0.7.0: Which chat is currently OPEN. Native ST marks this with a
    // highlight="true" attribute on the block element, but our proxy copies
    // block.innerHTML — which never includes the element's own attributes —
    // so the marker was silently lost. Rather than copying the attribute
    // (which native only sets at render time, so it can go stale), we compute
    // it live from context: context.chatId is the chat file name (no
    // extension) for solo chats and the group's chat_id for groups.
    function getActiveChatName() {
        try {
            const context = SillyTavern.getContext();
            let name = context.chatId;
            if ((name === undefined || name === null)
                && context.characterId !== undefined
                && context.characters?.[context.characterId]) {
                name = context.characters[context.characterId].chat;
            }
            return (name === undefined || name === null) ? null : String(name);
        } catch {
            return null;
        }
    }

    function isActiveChatFile(fileName) {
        const active = getActiveChatName();
        if (!active || !fileName) return false;
        return fileName.replace(/\.jsonl$/i, '') === active.replace(/\.jsonl$/i, '');
    }

    let activeScrolledThisOpen = false; // scroll to the open chat once per popup open

    // ========== ACTIVITY TRACKING (v0.9.0) ==========
    // "Last active" the way a chat list should mean it: the moment you last
    // interacted with the chat — opened it, sent, received, edited, swiped,
    // deleted a message. TMC stamps these events itself into a persisted,
    // character-scoped map. Sort key per chat = max(stamp, last-message time),
    // so:
    //   - a fresh branch is stamped the instant ST switches into it -> top,
    //     immediately, no server round-trip (branching copies old messages,
    //     so its last-message time is stale — the stamp overrides it);
    //   - chats never touched since install fall back to last-message time,
    //     which is correct for everything except pre-existing branches, and
    //     those self-heal to the top the first time they're opened.
    // v0.8.x tried to source this from /api/chats/recent mtime RANK instead;
    // that had two defects: max=100000 made the server line-stream the whole
    // library per popup open (seconds of latency before the list reordered),
    // and anything outside the rank fell back to the wrong clock anyway.
    const LAST_ACTIVE_HARD_CAP = 600;  // prune trigger
    const LAST_ACTIVE_KEEP = 500;      // entries kept after prune

    function lastActiveKey(chatName) {
        return String(getCurrentCharacterId() ?? '?') + '::' + String(chatName).replace(/\.jsonl$/i, '');
    }

    function stampActivity() {
        const charKey = getCurrentCharacterId();
        const chatName = getActiveChatName();
        if (!charKey || !chatName) return;
        const settings = getSettings();
        if (!settings.lastActive) settings.lastActive = {};
        settings.lastActive[lastActiveKey(chatName)] = Date.now();
        pruneLastActive(settings.lastActive);
        saveSettings();
    }

    function getLastActive(fileName) {
        const settings = getSettings();
        if (!settings.lastActive || !fileName) return 0;
        return settings.lastActive[lastActiveKey(fileName)] || 0;
    }

    function pruneLastActive(map) {
        const keys = Object.keys(map);
        if (keys.length <= LAST_ACTIVE_HARD_CAP) return;
        keys.sort((a, b) => map[a] - map[b]); // oldest first
        const removeCount = keys.length - LAST_ACTIVE_KEEP;
        for (let i = 0; i < removeCount; i++) delete map[keys[i]];
    }

    // ========== BRANCH METADATA (v0.8.0, repurposed v0.9.0) ==========
    // /api/chats/recent is now used ONLY for chat_metadata.main_chat (branch
    // parentage). Cost model of that endpoint: it stat()s every chat file
    // (cheap) but line-streams only the top `max` by mtime — so max stays
    // small. Branches older than the top 60 fall back to the filename
    // pattern in getBranchParent below.
    let activityData = { charKey: null, fetchedAt: 0, branchOf: {} };
    const ACTIVITY_TTL_MS = 15000;
    const BRANCH_FETCH_MAX = 60;

    // Pure: extract branch parentage for one character from the /recent
    // response. charKey: avatar png filename for solo chats, group id for
    // groups. Items from other characters, root-level stray .jsonl files,
    // and malformed entries are skipped.
    function buildActivityData(items, charKey) {
        const branchOf = {};
        for (const item of (Array.isArray(items) ? items : [])) {
            if (!item || typeof item.file_id !== 'string') continue;
            const key = item.avatar !== undefined ? item.avatar
                : (item.group !== undefined ? item.group : null);
            if (key === null || String(key) !== String(charKey)) continue;
            const parent = (item.chat_metadata && typeof item.chat_metadata.main_chat === 'string')
                ? item.chat_metadata.main_chat : null;
            if (parent && !(item.file_id in branchOf)) branchOf[item.file_id] = parent;
        }
        return { branchOf };
    }

    async function refreshActivityData(force = false) {
        const charKey = getCurrentCharacterId();
        if (!charKey) return;
        const now = Date.now();
        if (!force && activityData.charKey === charKey && (now - activityData.fetchedAt) < ACTIVITY_TTL_MS) return;
        // Stamp before the await so concurrent syncs don't stack requests.
        // If the character changed, the old branch map belongs to the previous
        // character — drop it NOW rather than serving it during the fetch.
        if (activityData.charKey !== charKey) {
            activityData = { charKey, fetchedAt: now, branchOf: {} };
        } else {
            activityData = { ...activityData, fetchedAt: now };
        }
        try {
            const context = SillyTavern.getContext();
            const headers = (typeof context.getRequestHeaders === 'function')
                ? context.getRequestHeaders()
                : { 'Content-Type': 'application/json' };
            const res = await fetch('/api/chats/recent', {
                method: 'POST',
                headers,
                // No `pinned` on purpose: ST floats pinned chats to the front
                // of this endpoint's ordering, which would eat top-N slots.
                body: JSON.stringify({ max: BRANCH_FETCH_MAX, metadata: true })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const items = await res.json();
            const { branchOf } = buildActivityData(items, charKey);
            activityData = { charKey, fetchedAt: Date.now(), branchOf };
            scheduleSync(); // re-render now that branch chips can appear
        } catch (err) {
            console.warn('[TMC] Branch metadata fetch failed — falling back to filename pattern only:', err);
            activityData = { charKey, fetchedAt: Date.now(), branchOf: {} };
        }
    }

    function getBranchParent(fileName) {
        const id = (fileName || '').replace(/\.jsonl$/i, '');
        if (activityData.branchOf[id]) return activityData.branchOf[id];
        // Filename-pattern fallback for branches outside the metadata fetch
        // window. Covers ST's default naming, current and legacy:
        //   "<parent> - Branch #3"  /  "Branch #3 - <parent>"
        let m = id.match(/^(.*) - Branch #\d+$/);
        if (m && m[1]) return m[1];
        m = id.match(/^Branch #\d+ - (.*)$/);
        if (m && m[1]) return m[1];
        return null;
    }

    // ========== BRANCH FAMILIES (v0.10.0) ==========
    // A "family" is one lineage: the parent chat plus every branch descended
    // from it. Branch-of-a-branch climbs transitively to the root; a seen-set
    // guards against pathological parentage cycles (renames can create
    // A -> B -> A chains in metadata).
    function resolveFamilyRoot(chatId) {
        let current = String(chatId || '').replace(/\.jsonl$/i, '');
        const seen = new Set([current]);
        for (let hops = 0; hops < 10; hops++) {
            const parent = getBranchParent(current);
            if (!parent) return current;
            const parentId = String(parent).replace(/\.jsonl$/i, '');
            if (seen.has(parentId)) return current; // cycle: stop at last sane node
            seen.add(parentId);
            current = parentId;
        }
        return current;
    }

    // Pure: cluster an already-sorted list of chat ids into families.
    // Returns { order, members, singles }:
    //   order   — family roots, in first-appearance order (so with the
    //             activity sort, the family containing the most recently
    //             active chat comes first);
    //   members — root -> ids (input order preserved inside each family);
    //   singles — non-branch chats with no branches of their own.
    // A lone branch whose parent was deleted still forms a family under the
    // (absent) parent's name — the lineage label is the useful information.
    function familyClusters(sortedIds, resolveRoot) {
        const members = {};
        const rootOrder = [];
        for (const id of (Array.isArray(sortedIds) ? sortedIds : [])) {
            const root = resolveRoot(id);
            if (!members[root]) {
                members[root] = [];
                rootOrder.push(root);
            }
            members[root].push(id);
        }
        const order = [];
        const singles = [];
        for (const root of rootOrder) {
            const m = members[root];
            const isRealFamily = m.length > 1 || m[0] !== root;
            if (isRealFamily) {
                order.push(root);
            } else {
                singles.push(m[0]);
                delete members[root];
            }
        }
        return { order, members, singles };
    }

    function familyCollapseKey(root) {
        return String(getCurrentCharacterId() ?? '?') + '::' + root;
    }

    // ========== MOVE CHAT TO ANOTHER CHARACTER CARD (v0.12.0) ==========
    // A real filesystem move via ST's own endpoints, ordered for safety:
    //   read source -> write to target (verified; save also runs ST's own
    //   backup) -> only then delete source (plain unlink, NO backup).
    // A save failure aborts with the source intact; a delete failure leaves a
    // duplicate — always the safe direction.

    function stHeaders() {
        const context = SillyTavern.getContext();
        return (typeof context.getRequestHeaders === 'function')
            ? context.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
    }

    function listOtherCharacters() {
        const context = SillyTavern.getContext();
        const current = getCurrentCharacterId();
        return (context.characters || [])
            .map((c, index) => ({ index, name: c?.name || '', avatar: c?.avatar || '' }))
            .filter(c => c.avatar && c.avatar !== current);
    }

    async function getTargetChatNames(targetAvatar) {
        const res = await fetch('/api/chats/search', {
            method: 'POST', headers: stHeaders(),
            body: JSON.stringify({ query: '', avatar_url: targetAvatar, group_id: null })
        });
        if (!res.ok) throw new Error('target listing failed: HTTP ' + res.status);
        const results = await res.json();
        return new Set((Array.isArray(results) ? results : []).map(r => normalizeChatId(r.file_name)));
    }

    // Authoritative existence probe: goes through the same server-side path
    // resolution (including sanitize()) that the save will use. A file that
    // exists but is empty reads as absent — there is nothing in it to lose.
    async function targetChatExists(avatar, name) {
        try {
            const res = await fetch('/api/chats/get', {
                method: 'POST', headers: stHeaders(),
                body: JSON.stringify({ avatar_url: avatar, file_name: name })
            });
            if (!res.ok) return false;
            const data = await res.json();
            return Array.isArray(data) && data.length > 0;
        } catch (e) {
            // Unknown is not "free": refuse to guess in the overwrite direction.
            console.warn('[TMC] Destination existence probe failed:', name, e);
            return true;
        }
    }

    // Never overwrite an existing chat on the target card.
    function pickFreeName(base, takenSet) {
        if (!takenSet.has(base)) return base;
        for (let n = 2; n < 1000; n++) {
            const candidate = `${base} #${n}`;
            if (!takenSet.has(candidate)) return candidate;
        }
        return `${base} ${Date.now()}`;
    }

    // v0.14.0: a fresh integrity token for the copy. ST stamps every chat it
    // loads with a uuid in chat_metadata.integrity and the server refuses a
    // save whose token disagrees with the token already in the target file —
    // that check is the last line of defence against clobbering someone
    // else's chat, so the copy must carry its own token rather than inheriting
    // the source's.
    function freshIntegrity() {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch { /* fall through */ }
        return 'tmc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    // Returns a NEW chat array adapted for the target card: header
    // character_name rewritten; AI messages whose speaker name equals the
    // SOURCE card's name are renamed to the target's. User messages and
    // differently-named NPCs are untouched.
    function adaptChatForTarget(chatArray, sourceName, targetName) {
        return chatArray.map((row, i) => {
            if (!row || typeof row !== 'object') return row;
            if (i === 0 && !('mes' in row)) {
                const meta = (row.chat_metadata && typeof row.chat_metadata === 'object')
                    ? { ...row.chat_metadata, integrity: freshIntegrity() }
                    : row.chat_metadata;
                return { ...row, character_name: targetName, ...(meta ? { chat_metadata: meta } : {}) };
            }
            if (!row.is_user && sourceName && targetName && row.name === sourceName) {
                return { ...row, name: targetName };
            }
            return row;
        });
    }

    async function moveChatToCharacter(fileName, sourceAvatar, sourceName, target, takenSet) {
        const id = normalizeChatId(fileName);
        // 1. read source
        const getRes = await fetch('/api/chats/get', {
            method: 'POST', headers: stHeaders(),
            body: JSON.stringify({ avatar_url: sourceAvatar, file_name: id })
        });
        if (!getRes.ok) return { ok: false, reason: 'read failed' };
        const data = await getRes.json();
        if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: 'empty or unreadable' };

        // 2. adapt + collision-free name.
        // v0.14.0: the listing-derived takenSet picks a candidate cheaply, but
        // it is NOT authoritative — /api/chats/save runs the destination
        // through sanitize(), so a name the listing said was free can still
        // land on an existing file. Probe the real path for each candidate.
        const adapted = adaptChatForTarget(data, sourceName, target.name);
        let destName = null;
        let candidate = pickFreeName(id, takenSet);
        for (let attempt = 0; attempt < 6; attempt++) {
            if (!await targetChatExists(target.avatar, candidate)) { destName = candidate; break; }
            takenSet.add(candidate); // occupied — never offer this name again
            candidate = pickFreeName(id, takenSet);
        }
        if (!destName) {
            return { ok: false, reason: 'no free name on the target card (source untouched)' };
        }
        takenSet.add(destName);

        // 3. write target. NOT forced: the copy carries its own integrity
        // token (see adaptChatForTarget), and the server's integrity check
        // passes freely for a file that does not exist yet — so leaving the
        // check ON costs nothing and turns any collision we failed to predict
        // into a rejected write instead of an overwritten chat.
        const saveRes = await fetch('/api/chats/save', {
            method: 'POST', headers: stHeaders(),
            body: JSON.stringify({ avatar_url: target.avatar, file_name: destName, chat: adapted })
        });
        let saveOk = saveRes.ok;
        if (saveOk) {
            try { saveOk = (await saveRes.json())?.ok === true; } catch { saveOk = false; }
        }
        if (!saveOk) return { ok: false, reason: 'write to target failed (source untouched)' };

        // 4. delete source — failure here means a duplicate, not a loss
        let warn = null;
        const delRes = await fetch('/api/chats/delete', {
            method: 'POST', headers: stHeaders(),
            body: JSON.stringify({ avatar_url: sourceAvatar, chatfile: id + '.jsonl' })
        });
        if (!delRes.ok) warn = 'copied, but source copy could not be deleted';

        // 5. bookkeeping on the source card — one canonical cleanup
        // (folders + pin + stamp) shared with bulk delete (v0.13.0).
        try {
            const settings = getSettings();
            stripDeletedFromFolders(settings, sourceAvatar, [id]);
            if (!settings.lastActive) settings.lastActive = {};
            // surface it on the target card immediately
            settings.lastActive[String(target.avatar) + '::' + destName] = Date.now();
            pruneLastActive(settings.lastActive);
            saveSettings();
        } catch (e) {
            console.warn('[TMC] Post-move bookkeeping failed:', e);
        }

        const originalBlock = findNativeBlock(fileName);
        if (originalBlock) originalBlock.remove();

        return { ok: true, destName, warn };
    }

    async function bulkMoveToCharacter(fileNames, target) {
        const context = SillyTavern.getContext();
        if (context.groupId) {
            toastr.info('Moving group chats between cards isn\'t supported');
            return;
        }
        const sourceAvatar = getCurrentCharacterId();
        if (!sourceAvatar) { toastr.error('No character selected'); return; }
        const sourceName = (context.characters || []).find(c => c?.avatar === sourceAvatar)?.name || '';

        let takenSet;
        try {
            takenSet = await getTargetChatNames(target.avatar);
        } catch (e) {
            console.warn('[TMC] Move aborted:', e);
            toastr.error('Could not list target card\'s chats — move aborted');
            return;
        }

        let moved = 0, skippedOpen = 0, failed = 0;
        const warns = [];
        for (const fileName of fileNames) {
            // Never move the chat ST currently holds in memory: its next
            // autosave would recreate the source file and desync everything.
            if (isActiveChatFile(fileName)) { skippedOpen++; continue; }
            try {
                const r = await moveChatToCharacter(fileName, sourceAvatar, sourceName, target, takenSet);
                if (r.ok) { moved++; if (r.warn) warns.push(`${fileName}: ${r.warn}`); }
                else { failed++; console.warn('[TMC] Move failed:', fileName, r.reason); }
            } catch (e) {
                failed++; console.warn('[TMC] Move failed:', fileName, e);
            }
        }

        let msg = `Moved ${moved} chat${moved !== 1 ? 's' : ''} to ${target.name}`;
        if (skippedOpen) msg += `, skipped ${skippedOpen} open`;
        if (failed) msg += `, ${failed} failed`;
        (failed ? toastr.warning : toastr.success)(msg);
        warns.forEach(w => toastr.info(w));
        scheduleSync();
    }

    function showCharacterPicker(e, fileNames) {
        document.querySelectorAll('.tmc_ctx').forEach(m => { if (m.cleanup) m.cleanup(); m.remove(); });

        const cards = listOtherCharacters();
        const menu = document.createElement('div');
        menu.className = 'tmc_ctx tmc_charpicker';
        menu.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);max-height:70vh;overflow-y:auto;min-width:240px;';

        menu.innerHTML = `<div class="tmc_ctx_head">Move ${fileNames.length} chat${fileNames.length !== 1 ? 's' : ''} to card…</div>
            <input type="text" class="tmc_charpicker_filter" placeholder="Filter cards…"
                   style="width:calc(100% - 16px);margin:4px 8px;box-sizing:border-box;">`;

        const list = document.createElement('div');
        for (const card of cards) {
            const item = document.createElement('div');
            item.className = 'tmc_ctx_item';
            item.textContent = '👤 ' + card.name;
            item.dataset.filterName = card.name.toLowerCase();
            item.onclick = async (ev) => {
                ev.stopPropagation();
                cleanup();
                await bulkMoveToCharacter(fileNames, card);
                clearSelection();
            };
            list.appendChild(item);
        }
        if (!cards.length) {
            list.innerHTML = '<div class="tmc_ctx_item" style="opacity:.6">No other character cards</div>';
        }
        menu.appendChild(list);
        document.body.appendChild(menu);

        const filter = menu.querySelector('.tmc_charpicker_filter');
        filter.oninput = () => {
            const q = filter.value.trim().toLowerCase();
            list.querySelectorAll('.tmc_ctx_item').forEach(it => {
                it.style.display = (!q || (it.dataset.filterName || '').includes(q)) ? '' : 'none';
            });
        };
        filter.onclick = (ev) => ev.stopPropagation();
        setTimeout(() => filter.focus(), 60);

        const closeHandler = (ev) => { if (!menu.contains(ev.target)) cleanup(); };
        const escHandler = (ev) => { if (ev.key === 'Escape') cleanup(); };
        function cleanup() {
            menu.remove();
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('keydown', escHandler);
        }
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            document.addEventListener('keydown', escHandler);
        }, 50);
        menu.cleanup = cleanup;
    }

    // ========== CARDS BROWSER (v0.12.0) ==========
    // "Only see chats for a specific character card" without switching cards
    // first: a browser mode listing every card as its own section with its
    // recent chats underneath. One bounded /recent call; clicking a chat
    // selects the card AND opens that chat; clicking a card header selects
    // the card and drops back to its normal per-card list.
    let cardsMode = false; // navigation surface — intentionally not persisted
    let cardsData = { fetchedAt: 0, items: [] };
    const CARDS_TTL_MS = 30000;
    const CARDS_FETCH_MAX = 300;

    async function refreshCardsData(force = false) {
        const now = Date.now();
        if (!force && (now - cardsData.fetchedAt) < CARDS_TTL_MS) return;
        cardsData = { ...cardsData, fetchedAt: now };
        try {
            const res = await fetch('/api/chats/recent', {
                method: 'POST', headers: stHeaders(),
                body: JSON.stringify({ max: CARDS_FETCH_MAX, metadata: false })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const items = await res.json();
            cardsData = { fetchedAt: Date.now(), items: Array.isArray(items) ? items : [] };
            scheduleSync();
        } catch (e) {
            console.warn('[TMC] Cards overview fetch failed:', e);
            cardsData = { fetchedAt: Date.now(), items: [] };
        }
    }

    // Pure: group /recent items into per-card sections, order = first
    // appearance (mtime-desc input, so the most recently active card leads).
    function buildCardsOverview(items, characters, groups) {
        const byKey = {};
        const order = [];
        for (const item of (Array.isArray(items) ? items : [])) {
            if (!item || typeof item.file_id !== 'string') continue;
            let type = null, key = null;
            if (item.avatar !== undefined) { type = 'char'; key = String(item.avatar); }
            else if (item.group !== undefined) { type = 'group'; key = String(item.group); }
            else continue; // root strays
            const mapKey = type + '::' + key;
            if (!byKey[mapKey]) {
                let name;
                if (type === 'char') {
                    name = (characters || []).find(c => c?.avatar === key)?.name
                        || key.replace(/\.png$/i, '');
                } else {
                    name = (groups || []).find(g => String(g?.id) === key)?.name
                        || ('Group ' + key);
                }
                byKey[mapKey] = { type, key, name, chats: [] };
                order.push(mapKey);
            }
            byKey[mapKey].chats.push({
                id: item.file_id,
                preview: item.mes || '',
                count: item.chat_items || 0,
            });
        }
        return order.map(k => byKey[k]);
    }

    async function jumpToCard(entry, chatId = null) {
        cardsMode = false;
        try {
            if (entry.type === 'group') {
                const g = await import('/scripts/group-chats.js');
                await g.openGroupById(entry.key);
                if (chatId) await g.openGroupChat(entry.key, chatId);
            } else {
                const s = await import('/script.js');
                const context = SillyTavern.getContext();
                const idx = (context.characters || []).findIndex(c => c?.avatar === entry.key);
                if (idx < 0) { toastr.error('Card not found: ' + entry.name); return; }
                await s.selectCharacterById(idx);
                if (chatId) await s.openCharacterChat(chatId);
            }
        } catch (e) {
            console.error('[TMC] Jump failed:', e);
            toastr.error('Could not open ' + entry.name);
        }
        scheduleSync();
    }

    function renderCardsTree(proxyRoot) {
        const context = SillyTavern.getContext();
        const overview = buildCardsOverview(cardsData.items, context.characters, context.groups);
        const frag = document.createDocumentFragment();

        const note = document.createElement('div');
        note.className = 'tmc_cards_note';
        note.textContent = overview.length
            ? 'All cards, most recently active first — tap a card to browse it, tap a chat to jump straight in.'
            : (cardsData.fetchedAt ? 'No recent chats found.' : 'Loading cards…');
        frag.appendChild(note);

        for (const entry of overview) {
            const section = document.createElement('div');
            section.className = 'tmc_section tmc_card_section';

            const header = document.createElement('div');
            header.className = 'tmc_header';
            header.style.cursor = 'pointer';
            header.innerHTML = `
                <div class="tmc_header_left">
                    <span class="tmc_icon"><i class="fa-solid ${entry.type === 'group' ? 'fa-users' : 'fa-user'}"></i></span>
                    <span class="tmc_name">${escapeHtml(entry.name)}</span>
                    <span class="tmc_count">${entry.chats.length}</span>
                </div>`;
            header.title = 'Open this card\'s chat list';
            header.onclick = () => jumpToCard(entry);
            section.appendChild(header);

            const content = document.createElement('div');
            content.className = 'tmc_content';
            for (const chat of entry.chats.slice(0, 8)) {
                const row = document.createElement('div');
                row.className = 'tmc_card_chat';
                row.innerHTML = `<span class="tmc_card_chat_title">${escapeHtml(chat.id)}</span>
                    <span class="tmc_card_chat_preview">${escapeHtml(String(chat.preview).slice(0, 90))}</span>`;
                row.onclick = () => jumpToCard(entry, chat.id);
                content.appendChild(row);
            }
            if (entry.chats.length > 8) {
                const more = document.createElement('div');
                more.className = 'tmc_show_more';
                more.innerHTML = `<i class="fa-solid fa-ellipsis"></i> ${entry.chats.length - 8} more — open the card`;
                more.onclick = () => jumpToCard(entry);
                content.appendChild(more);
            }
            section.appendChild(content);
            frag.appendChild(section);
        }

        proxyRoot.innerHTML = '';
        proxyRoot.appendChild(frag);
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // v0.12.1: human-relative timestamp for the activity hint chip.
    function formatRelativeTime(ts, now = Date.now()) {
        const d = Math.max(0, now - ts);
        const m = Math.floor(d / 60000);
        if (m < 1) return 'now';
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    }

    // v0.12.1: pure builder for the context menu's Move-to section. The old
    // section unconditionally showed a bare '💬 Your chats' entry — which,
    // with no folders created and the chat already uncategorized, was a
    // silent no-op button (reported as 'I click it and nothing happens').
    // Rules: folders listed with a ✓ on the current one; 'Remove from folder'
    // only when the chat is actually in one; 'New folder…' always available;
    // with zero folders the section is JUST 'New folder…'.
    function buildMoveSectionHtml(folderList, currentFid, isBulk) {
        let html = '<div class="tmc_ctx_sep"></div><div class="tmc_ctx_head">Move to</div>';
        for (const f of folderList) {
            const isCurrent = !isBulk && f.fid === currentFid;
            html += `<div class="tmc_ctx_item${isCurrent ? ' tmc_ctx_current' : ''}" data-fid="${f.fid}">📁 ${escapeHtml(f.name)}${isCurrent ? ' ✓' : ''}</div>`;
        }
        if (isBulk) {
            if (folderList.length) html += '<div class="tmc_ctx_item" data-fid="uncategorized">🚫 Remove from folders</div>';
        } else if (folderList.length && currentFid !== 'uncategorized') {
            html += '<div class="tmc_ctx_item" data-fid="uncategorized">🚫 Remove from folder</div>';
        }
        html += '<div class="tmc_ctx_item" data-action="newfolder-move">➕ New folder…</div>';
        return html;
    }

    // v0.8.1: file names go into querySelector attribute values in several
    // places; a name containing " or \ breaks the selector (legal chars in
    // Linux filenames). Escape for use inside [file_name="..."].
    function escAttr(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // v0.11.0: chat identity is the file name WITHOUT extension. ST builds
    // have flip-flopped on whether the block's file_name attribute carries
    // .jsonl; anything persisted (folder membership, pins) must compare
    // normalized or assignments silently break across ST updates.
    function normalizeChatId(fileName) {
        return String(fileName || '').replace(/\.jsonl$/i, '');
    }

    // v0.13.0 ROOT FIX: decide whether a cached native-block parse is still
    // valid. Identity alone is no longer enough — current ST's search does
    // NOT toggle display on existing blocks; it re-fetches /api/chats/search
    // per keystroke and REBUILDS every block, so an identity-only cache
    // missed on 100% of search keystrokes (the exact scenario it existed
    // for). A rebuilt block whose text is unchanged is the same data: adopt
    // the new element, keep the parse. Any real change (new message ->
    // new date/size/count text) changes the signature and re-parses.
    function reuseCachedNative(cached, block) {
        if (!cached) return false;
        if (cached.element === block) return true;
        if (cached.signature !== undefined && cached.signature === block.textContent) {
            cached.element = block;
            return true;
        }
        return false;
    }

    // v0.13.0 ROOT FIX: pins float to the top of their section WITHOUT
    // inverting their relative order. The old unshift-per-pin put multiple
    // pinned chats in REVERSE sort order (each new pin shoved the previous
    // one down). Pure; preserves the global sort inside both partitions.
    function partitionPinned(list, isPinnedFn) {
        const pinned = [];
        const rest = [];
        for (const item of (Array.isArray(list) ? list : [])) {
            (isPinnedFn(item) ? pinned : rest).push(item);
        }
        return pinned.concat(rest);
    }

    // v0.13.0: migrate every piece of persisted bookkeeping keyed by a
    // chat's old name to its new name. Driven by ST's CHAT_RENAMED event
    // (see init). Pure over the settings object; returns true if anything
    // changed. charKey: avatar for solo, group id for groups. oldId/newId:
    // normalized (no .jsonl).
    function migrateChatRename(settings, charKey, oldId, newId) {
        if (!charKey || !oldId || !newId || oldId === newId) return false;
        let changed = false;
        const folderIds = (settings.characterFolders && settings.characterFolders[charKey]) || [];
        for (const fid of folderIds) {
            const folder = settings.folders && settings.folders[fid];
            if (!folder || !Array.isArray(folder.chats)) continue;
            const idx = folder.chats.findIndex(c => normalizeChatId(c) === oldId);
            if (idx > -1) {
                folder.chats[idx] = newId;
                // A stale ghost entry under the new name may already exist
                // (delete + later re-create under the same name) — dedupe.
                folder.chats = [...new Set(folder.chats.map(normalizeChatId))];
                changed = true;
            }
        }
        const oldKey = String(charKey) + '::' + oldId;
        const newKey = String(charKey) + '::' + newId;
        if (settings.pinned && settings.pinned[oldKey]) {
            delete settings.pinned[oldKey];
            settings.pinned[newKey] = true;
            changed = true;
        }
        if (settings.lastActive && settings.lastActive[oldKey]) {
            settings.lastActive[newKey] = Math.max(settings.lastActive[newKey] || 0, settings.lastActive[oldKey]);
            delete settings.lastActive[oldKey];
            changed = true;
        }
        if (settings.familyCollapsed && Object.hasOwn(settings.familyCollapsed, oldKey)) {
            settings.familyCollapsed[newKey] = settings.familyCollapsed[oldKey];
            delete settings.familyCollapsed[oldKey];
            changed = true;
        }
        return changed;
    }

    // v0.13.0: one canonical cleanup for chats that left this card (bulk
    // delete, move-to-card source side): folder membership, pin, activity
    // stamp. Normalized-to-normalized comparison — the old raw
    // `!toDelete.includes(f)` silently matched nothing on builds where
    // block file_name carries .jsonl, leaving ghost assignments behind.
    function stripDeletedFromFolders(settings, charKey, deletedNames) {
        if (!charKey) return false;
        const delSet = new Set((Array.isArray(deletedNames) ? deletedNames : []).map(normalizeChatId));
        if (delSet.size === 0) return false;
        let changed = false;
        const folderIds = (settings.characterFolders && settings.characterFolders[charKey]) || [];
        for (const fid of folderIds) {
            const folder = settings.folders && settings.folders[fid];
            if (!folder || !Array.isArray(folder.chats)) continue;
            const before = folder.chats.length;
            folder.chats = folder.chats.filter(c => !delSet.has(normalizeChatId(c)));
            if (folder.chats.length !== before) changed = true;
        }
        for (const id of delSet) {
            const key = String(charKey) + '::' + id;
            if (settings.pinned && settings.pinned[key]) { delete settings.pinned[key]; changed = true; }
            if (settings.lastActive && settings.lastActive[key]) { delete settings.lastActive[key]; changed = true; }
        }
        return changed;
    }

    // v0.14.0 ROOT FIX (data integrity). ST has TWO delete paths and they are
    // not equivalent:
    //   * the UI path (.PastChat_cross -> handleDeleteChat -> delChat) calls
    //     replaceCurrentChat() when the deleted file is the LOADED chat, i.e.
    //     it clears the in-memory chat and loads a replacement;
    //   * deleteCharacterChatByName() / deleteGroupChatByName() only repoint
    //     the card's (or group's) chat pointer at some other existing file and
    //     leave the deleted chat sitting in memory.
    // TMC's bulk delete used the second kind for everything, so deleting the
    // OPEN chat left ST holding a deleted chat whose chat_metadata.integrity
    // belonged to the removed file while the save target had become a
    // DIFFERENT, live chat. The next save then either tripped ST's integrity
    // guard ("enter OVERWRITE to LOSE YOUR DATA", followed by a forced page
    // reload) or — if that other chat predates integrity metadata, so the
    // server skips the check — silently overwrote it with the deleted chat's
    // messages. TMC already refused to move the open chat for exactly this
    // class of reason; delete never got the same treatment.
    // The fix keeps the fast path for every chat that is NOT open, and routes
    // the open one through ST's own chat-aware teardown, last.
    // Pure so the ordering can be proved in the suite.
    function partitionOpenChat(fileNames, isOpenFn) {
        const others = [];
        const open = [];
        for (const f of (Array.isArray(fileNames) ? fileNames : [])) {
            (isOpenFn(f) ? open : others).push(f);
        }
        return { others, open };
    }

    // v0.13.0: existence-based, not name-based — a folder literally named
    // "?" used to vanish from the Move-to menu.
    function buildFolderList(settings, characterId) {
        const folderIds = (settings.characterFolders && settings.characterFolders[characterId]) || [];
        return folderIds
            .filter(fid => settings.folders && settings.folders[fid])
            .map(fid => ({ fid, name: settings.folders[fid].name }));
    }

    // v0.13.0 ROOT FIX: .tmc_ctx is position:fixed; after placing a menu at
    // the tap point, clamp it fully inside the viewport. A kebab tap near
    // the bottom of a phone screen used to push most of the menu off-screen.
    function clampMenuToViewport(menu, win = window) {
        const pad = 8;
        const r = menu.getBoundingClientRect();
        let left = r.left, top = r.top;
        if (r.right > win.innerWidth - pad) left = win.innerWidth - pad - r.width;
        if (left < pad) left = pad;
        if (r.bottom > win.innerHeight - pad) top = win.innerHeight - pad - r.height;
        if (top < pad) top = pad;
        menu.style.left = left + 'px';
        menu.style.right = 'auto';
        menu.style.top = top + 'px';
    }

    // v0.11.0: current ST templates use .select_chat_block_filename for the
    // title row; older builds used .select_chat_block_title / .avatar_title_div.
    // Every title lookup goes through here — with the old two-class lookup,
    // search title-highlighting was silently dead on current ST and the
    // pin/Open/branch chips fell back to prepending on the block itself.
    function getTitleEl(el) {
        return el.querySelector('.select_chat_block_filename, .select_chat_block_title, .avatar_title_div');
    }

    // v0.14.0 ROOT FIX: the search box used to be located POSITIONALLY, with
    // `input[type="search"], input[type="text"], .search_input` — the first
    // match in document order. ST's popup header contains four other <input>
    // elements BEFORE the search box (the hidden chat-import form). They only
    // fail to match today because they carry no `type` attribute at all; the
    // day one of them gains type="text", TMC binds its input listener to a
    // hidden field and search dies silently. ST's search box has a stable id.
    // One resolver, used by every consumer.
    function findSearchInput(popup) {
        return popup.querySelector('#select_chat_search')
            || popup.querySelector('input[type="search"]')
            || popup.querySelector('input.search_input')
            || popup.querySelector('input[type="text"]')
            || null;
    }

    // v0.14.0 ROOT FIX: which element actually SCROLLS the proxy list. This
    // was previously guessed as `.shadow_select_chat_popup_body || popup` — a
    // class that does not exist in any current ST build, so it always
    // resolved to #shadow_select_chat_popup, which has no overflow and never
    // scrolls. Two features were silently dead as a result: scroll
    // preservation across rebuilds (scrollTop read 0, restore never ran, so
    // every background resync snapped the list to the top) and the lazy-load
    // observer's 300px prefetch margin (rootMargin expands the ROOT's rect,
    // but the real clip came from #tmc_proxy_root further down, so batches
    // only loaded once "Loading..." was already on screen).
    // TMC's own stylesheet makes #tmc_proxy_root the scroller, so that is the
    // answer; the ancestor walk is the fallback for a user stylesheet that
    // moves the overflow somewhere else.
    function getScrollContainer(popup, proxyRoot) {
        const scrolls = (el) => {
            if (!el) return false;
            try {
                const oy = getComputedStyle(el).overflowY;
                return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
            } catch { return false; }
        };
        if (scrolls(proxyRoot)) return proxyRoot;
        let node = proxyRoot && proxyRoot.parentElement;
        while (node && node !== document.body) {
            if (scrolls(node)) return node;
            node = node.parentElement;
        }
        return proxyRoot || popup;
    }

    // Find the ORIGINAL (native, non-proxy) block for a chat file.
    function findNativeBlock(fileName) {
        return document.querySelector(`.select_chat_block[file_name="${escAttr(fileName)}"]:not(.tmc_proxy_block)`);
    }

    // v0.14.0: resolve a chat's last-message time to a NUMBER, the only form
    // anything downstream actually consumes (sort keys, the activity floor).
    // Order: the native date cell, then the timestamp ST writes into its own
    // default chat file names ("Name - 2026-07-30@12h34m56s" / plain ISO).
    // Returns 0 when nothing parses — never NaN, which would poison
    // Math.max() and make comparators return NaN.
    function resolveBlockDate(cellText, fileName) {
        const fromCell = cellText ? Date.parse(String(cellText)) : NaN;
        if (Number.isFinite(fromCell)) return fromCell;
        const id = String(fileName || '');
        const st = id.match(/(\d{4}-\d{2}-\d{2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/);
        if (st) {
            const t = Date.parse(`${st[1]}T${st[2].padStart(2, '0')}:${st[3].padStart(2, '0')}:${st[4].padStart(2, '0')}`);
            if (Number.isFinite(t)) return t;
        }
        const iso = id.match(/\d{4}-\d{2}-\d{2}/);
        if (iso) {
            const t = Date.parse(iso[0]);
            if (Number.isFinite(t)) return t;
        }
        return 0;
    }

    function extractChatTitle(fileName) {
        if (!fileName) return 'Untitled';
        // Remove .jsonl extension and clean up
        return fileName.replace(/\.jsonl$/i, '').trim() || 'Untitled';
    }

    // v0.14.0 ROOT FIX: highlighting used to run a regex over ALREADY
    // HTML-ESCAPED text and feed the result to innerHTML. Three defects fell
    // out of that shape:
    //   (1) searching "&" matched inside the entity "&amp;" and produced
    //       "&<span>amp;</span>"; searching "<" never matched anything at all,
    //       because the haystack held "&lt;";
    //   (2) safety depended on escape-then-highlight ORDERING staying correct
    //       at every call site forever — one site forgetting escapeHtml() was
    //       an XSS (that is exactly the v0.7.0 title bug);
    //   (3) the injected inline style hardcoded color:#fff, invisible on
    //       light themes.
    // Highlighting is now a DOM operation over PLAIN text. splitHighlight is
    // pure (segments in, segments out) and applyHighlight builds text nodes
    // plus <span class="tmc_hl"> elements. No HTML string is constructed
    // anywhere on this path, so there is nothing left to escape and nothing
    // left to order wrongly. Matching is literal (indexOf), so regex
    // metacharacters in a search term are inert by construction.
    function splitHighlight(text, term) {
        const s = String(text === undefined || text === null ? '' : text);
        const t = String(term === undefined || term === null ? '' : term);
        if (!t || !s) return [{ text: s, hit: false }];
        const hay = s.toLowerCase();
        const needle = t.toLowerCase();
        const parts = [];
        let i = 0;
        for (;;) {
            const at = hay.indexOf(needle, i);
            if (at === -1) break;
            if (at > i) parts.push({ text: s.slice(i, at), hit: false });
            parts.push({ text: s.slice(at, at + needle.length), hit: true });
            i = at + needle.length;
        }
        if (i < s.length) parts.push({ text: s.slice(i), hit: false });
        return parts.length ? parts : [{ text: s, hit: false }];
    }

    // Replaces el's contents with `text`, wrapping every case-insensitive
    // occurrence of `term` in a highlight span. Never touches innerHTML.
    function applyHighlight(el, text, term) {
        if (!el) return;
        el.textContent = '';
        for (const part of splitHighlight(text, term)) {
            if (!part.text) continue;
            if (part.hit) {
                const mark = document.createElement('span');
                mark.className = 'tmc_hl';
                mark.textContent = part.text;
                el.appendChild(mark);
            } else {
                el.appendChild(document.createTextNode(part.text));
            }
        }
    }

    // ========== SEARCH CONTEXT PREVIEW ==========

    // Fetches the full message content for a chat file from ST's backend.
    // Returns an array of message strings (cached after first fetch).
    // Fails soft: on any error, resolves to [] rather than throwing, so a
    // fetch problem never breaks the (already-working) list rendering -
    // it just means that one entry keeps showing its normal last-message preview.
    async function fetchChatMessages(fileName) {
        const key = contentCacheKey(fileName);
        // v0.16.0: a cached entry whose fetch FAILED only counts as a hit for
        // CONTENT_ERROR_RETRY_MS (bounding retry traffic to once per window);
        // after that it reads as a miss and the network gets another chance.
        const errStale = chatContentErrAt[key]
            && (Date.now() - chatContentErrAt[key]) >= CONTENT_ERROR_RETRY_MS;
        if (chatContentCache[key] && !errStale) {
            touchContentCache(key);
            return chatContentCache[key];
        }
        if (chatContentPromises[key]) return chatContentPromises[key];

        const promise = (async () => {
            // v0.16.0: a MESSAGE_* event may fire (and bump the generation)
            // while this fetch is in the air — captured here so the result
            // can be refused if the cache was invalidated meanwhile.
            const gen = contentCacheGeneration;
            try {
                const context = SillyTavern.getContext();
                const headers = (typeof context.getRequestHeaders === 'function')
                    ? context.getRequestHeaders()
                    : { 'Content-Type': 'application/json' };

                const isGroup = !!context.groupId;
                // v0.8.1 FIX: the group branch used to send { id: context.groupId },
                // i.e. /api/chats/group/get for the CURRENTLY OPEN chat — so every
                // group chat's search preview showed snippets from whatever chat
                // you happened to have open. Group chat files are keyed by chat
                // id, which is exactly this list entry's fileName without .jsonl.
                const url = isGroup ? '/api/chats/group/get' : '/api/chats/get';
                const body = isGroup
                    ? { id: fileName.replace(/\.jsonl$/i, '') }
                    : { avatar_url: getCurrentCharacterId(), file_name: fileName };

                const res = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                });

                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();

                // The response is an array; the first line is a chat-header
                // object (no 'mes' field) and the rest are message objects.
                const messages = Array.isArray(data)
                    ? data.filter(m => m && typeof m.mes === 'string').map(m => m.mes)
                    : [];

                // v0.16.0: if the generation moved on, the chat changed while
                // this fetch was in flight — the content just read is the OLD
                // turn. Serve it to this render pass, but do NOT write it
                // into the cache: the stale copy would outlive the
                // invalidation and the next popup would show the pre-turn
                // preview until yet another message landed.
                if (gen === contentCacheGeneration) {
                    delete chatContentErrAt[key];
                    chatContentCache[key] = messages;
                    touchContentCache(key);
                }
                return messages;
            } catch (err) {
                console.warn('[TMC] Could not fetch chat content for search preview:', fileName, err);
                // v0.16.0: cache the failure briefly (see CONTENT_ERROR_RETRY_MS)
                // so a flaky endpoint is not hammered once per sync, and
                // resolve to null so callers can tell "fetch failed" apart
                // from "fetched, but empty" — a network error must never mark
                // a chat as permanently known-empty.
                chatContentErrAt[key] = Date.now();
                chatContentCache[key] = [];
                touchContentCache(key);
                return null;
            } finally {
                delete chatContentPromises[key];
            }
        })();

        chatContentPromises[key] = promise;
        return promise;
    }

    // Finds the first occurrence of `term` across all messages and returns a
    // short snippet of surrounding context (not just the matched word).
    function buildContextSnippet(messages, term, contextChars = 55) {
        if (!term || !messages || !messages.length) return null;
        const lowerTerm = term.toLowerCase();

        for (const mes of messages) {
            if (!mes) continue;
            const idx = mes.toLowerCase().indexOf(lowerTerm);
            if (idx === -1) continue;

            const start = Math.max(0, idx - contextChars);
            const end = Math.min(mes.length, idx + term.length + contextChars);
            let snippet = mes.slice(start, end).replace(/\s+/g, ' ').trim();
            if (start > 0) snippet = '…' + snippet;
            if (end < mes.length) snippet = snippet + '…';
            return snippet;
        }
        return null;
    }

    // Heuristic for locating the preview text node inside a native chat
    // block. ST doesn't expose a stable class name we can rely on across
    // versions, so instead we pick the leaf element (no element children)
    // with the most text, excluding the title and any action/button areas -
    // in practice this is reliably the last-message preview.
    function findPreviewElement(el, titleEl) {
        // v0.13.0: current ST has a stable class for the last-message
        // preview — use it when present; the leaf-with-most-text heuristic
        // below stays as the fallback for older builds.
        const stable = el.querySelector('.select_chat_block_mes');
        if (stable) return stable;
        const candidates = el.querySelectorAll('div, span, p, small');
        let best = null;
        let bestLen = 0;

        candidates.forEach(node => {
            if (node === titleEl || (titleEl && titleEl.contains(node))) return;
            if (node.children.length > 0) return; // want a leaf text container
            if (node.closest('button, .tmc_mobile_menu, [class*="action"], [class*="button"]')) return;

            const text = node.textContent.trim();
            if (text.length > bestLen) {
                bestLen = text.length;
                best = node;
            }
        });

        return best;
    }

    // Kicks off (async) replacement of a block's last-message preview with a
    // highlighted snippet of context around the actual search match.
    // Leaves the original preview untouched until/unless a match is found,
    // and guards against the search term having changed by the time the
    // fetch resolves (so fast typing can't leave stale snippets behind).
    function enrichPreviewWithContext(el, fileName, searchTerm, titleEl) {
        const previewEl = findPreviewElement(el, titleEl);
        if (!previewEl) return;

        fetchChatMessages(fileName).then(messages => {
            if (!el.isConnected) return; // block was removed/re-rendered already
            // v0.16.0: null = the FETCH failed — nothing is known yet, leave
            // the native preview alone and let a later render retry.
            if (messages === null) return;

            const snippet = buildContextSnippet(messages, searchTerm);
            if (!snippet) return; // no match in content - leave last-message preview as-is

            applyHighlight(previewEl, snippet, searchTerm);
            previewEl.title = snippet; // full snippet on hover, in case it's truncated visually
            previewEl.classList.add('tmc_context_preview');
        });
    }

    // ========== LAST-MESSAGE BEGINNING PREVIEW ==========

    // Pure: the beginning of the LAST message — the text ST's own Recent
    // Chats panel leads with. Whitespace-collapsed into a single visual line
    // (the native 3-line CSS clamp does the visible truncation; raw newlines
    // would eat that budget). null when there is nothing usable, so callers
    // keep the native preview as the fallback.
    function buildBeginningPreview(messages, maxChars = 400) {
        if (!Array.isArray(messages) || messages.length === 0) return null;
        const last = messages[messages.length - 1];
        if (typeof last !== 'string' || !last.trim()) return null;
        const flat = last.replace(/\s+/g, ' ').trim();
        return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
    }

    // Kicks off (async) replacement of a block's tail preview with the
    // BEGINNING of the last message. Same contract as
    // enrichPreviewWithContext: the native preview stays until/unless the
    // fetch yields text, and a detached block is never written to.
    function enrichPreviewWithBeginning(el, fileName, titleEl) {
        const previewEl = findPreviewElement(el, titleEl);
        if (!previewEl) return;

        const key = contentCacheKey(fileName);
        const cached = beginningPreviewCache[key];
        if (cached) { // known beginning — apply synchronously, no fetch
            previewEl.textContent = cached;
            previewEl.title = cached;
            return;
        }
        if (cached === '') return; // known empty/failed — keep native preview

        fetchChatMessages(fileName).then(messages => {
            // v0.16.0: null = the FETCH failed. Nothing is "known" about this
            // chat yet, so nothing is cached — the '' sentinel used to be
            // written here too, poisoning the preview for the session. A
            // genuinely empty chat (fetched fine, nothing usable) still
            // caches '' so it is not refetched on every sync.
            if (messages === null) return; // transient failure — keep native preview, retry next render
            const beginning = buildBeginningPreview(messages);
            beginningPreviewCache[key] = beginning || '';
            if (!beginning || !el.isConnected) return; // keep native preview
            previewEl.textContent = beginning;
            previewEl.title = beginning;
        });
    }

    // The last message of the open chat changes with every turn, so a cached
    // beginning (or search-context message list) built from the old content
    // is stale the moment a message lands. Both caches are small and
    // fail-soft; wholesale invalidation on message events is the one rule
    // that can never serve a stale preview.
    function invalidateChatContentCaches() {
        // v0.16.0: bump the generation FIRST — fetches still in flight hold
        // the old one and will no longer write their (now stale) results
        // back into the cache when they resolve.
        contentCacheGeneration++;
        for (const k of Object.keys(chatContentCache)) delete chatContentCache[k];
        contentCacheOrder.length = 0;
        for (const k of Object.keys(beginningPreviewCache)) delete beginningPreviewCache[k];
        for (const k of Object.keys(chatContentErrAt)) delete chatContentErrAt[k];
    }


    function createFolder(name) {
        if (!name || !name.trim()) return null;
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) {
            console.warn('[TMC] getCurrentCharacterId returned null. Context:', SillyTavern.getContext());
            toastr.warning('Please select a character first');
            return null;
        }

        const folderId = generateId();
        const existingCount = (settings.characterFolders[characterId] || []).length;

        settings.folders[folderId] = {
            name: name.trim(),
            chats: [],
            collapsed: false,
            order: existingCount
        };

        if (!settings.characterFolders[characterId]) settings.characterFolders[characterId] = [];
        settings.characterFolders[characterId].push(folderId);

        saveSettings();
        scheduleSync();
        return folderId;
    }

    function renameFolder(folderId, newName) {
        if (!newName || !newName.trim()) return;
        const settings = getSettings();
        if (settings.folders[folderId]) {
            settings.folders[folderId].name = newName.trim();
            saveSettings();
            scheduleSync();
        }
    }

    function setFolderColor(folderId, colorKeyOrHex) {
        const settings = getSettings();
        if (settings.folders[folderId]) {
            // Check if it's a key in FOLDER_COLORS, otherwise treat as hex
            if (FOLDER_COLORS[colorKeyOrHex]) {
                settings.folders[folderId].color = colorKeyOrHex;
            } else {
                // It is a hex from picker
                settings.folders[folderId].color = colorKeyOrHex;
            }
            saveSettings();
            scheduleSync();
        }
    }

    // v0.8.1 FIX: pins used to be keyed by bare fileName — pinning "New Chat"
    // on one character pinned every same-named chat on every character. Keys
    // are now character-scoped; legacy bare keys are still honored on read
    // and migrated to the scoped form the next time that pin is toggled.
    function pinKey(fileName) {
        return String(getCurrentCharacterId() ?? '?') + '::' + normalizeChatId(fileName);
    }

    function isPinnedFile(fileName) {
        const settings = getSettings();
        if (!settings.pinned) return false;
        const bare = normalizeChatId(fileName);
        // scoped key, then every legacy global spelling (with/without .jsonl)
        return !!(settings.pinned[pinKey(fileName)]
            || settings.pinned[fileName]
            || settings.pinned[bare]
            || settings.pinned[bare + '.jsonl']);
    }

    function togglePin(fileName) {
        const settings = getSettings();
        if (!settings.pinned) settings.pinned = {};

        const scoped = pinKey(fileName);
        const bare = normalizeChatId(fileName);
        const wasPinned = !!(settings.pinned[scoped] || settings.pinned[fileName]
            || settings.pinned[bare] || settings.pinned[bare + '.jsonl']);

        // Migrate every legacy global spelling away regardless of direction.
        delete settings.pinned[fileName];
        delete settings.pinned[bare];
        delete settings.pinned[bare + '.jsonl'];

        if (wasPinned) {
            delete settings.pinned[scoped];
        } else {
            settings.pinned[scoped] = true;
        }
        saveSettings();
        scheduleSync();
    }

    function deleteFolder(folderId) {
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) return;

        const charFolders = settings.characterFolders[characterId];
        if (charFolders) {
            const idx = charFolders.indexOf(folderId);
            if (idx > -1) charFolders.splice(idx, 1);
        }

        delete settings.folders[folderId];
        saveSettings();
        scheduleSync();
    }

    // Single-chat move. One implementation only — moveChats does the work, so
    // the one-chat and many-chats paths can never drift apart (they did: the
    // bulk path used to loop this function, paying a settings write and a
    // render schedule per chat).
    function moveChat(fileName, targetFolderId) {
        moveChats([fileName], targetFolderId);
    }

    // v0.14.0: moving N chats used to call moveChat() N times — N
    // saveSettings() calls and N scheduleSync() calls, each one resetting the
    // other's debounce timer. Bulk paths go through here: one settings write,
    // one render.
    function moveChats(fileNames, targetFolderId) {
        const list = Array.isArray(fileNames) ? fileNames : [fileNames];
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId || !list.length) return;

        const targets = new Set(list.map(normalizeChatId));
        const allFolderIds = settings.characterFolders[characterId] || [];
        for (const fid of allFolderIds) {
            const folder = settings.folders[fid];
            if (folder && Array.isArray(folder.chats)) {
                folder.chats = folder.chats.filter(c => !targets.has(normalizeChatId(c)));
            }
        }
        if (targetFolderId && targetFolderId !== 'uncategorized') {
            const folder = settings.folders[targetFolderId];
            if (folder) {
                if (!Array.isArray(folder.chats)) folder.chats = [];
                for (const id of targets) folder.chats.push(id);
            }
        }
        saveSettings();
        scheduleSync();
    }

    function getFolderForChat(fileName) {
        const settings = getSettings();
        const characterId = getCurrentCharacterId();
        if (!characterId) return 'uncategorized';

        const target = normalizeChatId(fileName);
        const folderIds = settings.characterFolders[characterId] || [];
        for (const fid of folderIds) {
            const folder = settings.folders[fid];
            if (folder && folder.chats && folder.chats.some(c => normalizeChatId(c) === target)) {
                return fid;
            }
        }
        return 'uncategorized';
    }






    // Sorting Helpers
    function getChatMetadata(block, fileName) {
        try {
            // Name
            const name = (fileName || '').toLowerCase();

            // Date (Native). v0.14.0: the native date cell is rendered by
            // moment's locale-dependent 'lll' format, so Date.parse() of it
            // silently returns NaN on non-English ST installs — which used to
            // make the "Last Msg" sort a no-op and drop the activity sort's
            // floor to 0 for every chat. resolveBlockDate falls back to the
            // timestamp ST bakes into its own default chat filenames.
            const dateEl = block.querySelector('.chat_messages_date');
            const date = resolveBlockDate(dateEl ? dateEl.textContent : '', fileName);

            // Message Count (123 💬)
            const msgEl = block.querySelector('.chat_messages_num');
            const msgStr = msgEl ? msgEl.textContent : '0';
            const msgCount = parseInt(msgStr.replace(/[^0-9]/g, '')) || 0;

            // File Size ((29.96KB, ...)
            const sizeEl = block.querySelector('.chat_file_size');
            const sizeStr = sizeEl ? sizeEl.textContent : '';
            let size = 0;
            if (sizeStr) {
                const match = sizeStr.match(/([\d.]+)\s*([KMGT]?B)/i);
                if (match) {
                    const val = parseFloat(match[1]);
                    const unit = match[2].toUpperCase();
                    if (unit === 'KB') size = val * 1024;
                    else if (unit === 'MB') size = val * 1024 * 1024;
                    else if (unit === 'GB') size = val * 1024 * 1024 * 1024;
                    else size = val;
                }
            }

            return { name, date, msgCount, size };
        } catch (err) {
            console.error('[TMC] Metadata Error:', err);
            return { name: '', date: 0, msgCount: 0, size: 0 };
        }
    }

    function sortChats(chatDataList) {
        return chatDataList.sort((a, b) => {
            const metaA = a.metadata;
            const metaB = b.metadata;

            switch (sortOrder) {
                // v0.9.0: "last active" = max(interaction stamp, last-message
                // time). The stamp covers exactly the case where the two
                // clocks diverge: a branch carries copied old messages, so its
                // last-message time lies about when you actually touched it.
                // Unstamped chats (untouched since install) reduce cleanly to
                // last-message ordering.
                case 'activity-desc': {
                    // a.activity/b.activity precomputed once per item per sync
                    // (see performSync) = max(interaction stamp, last-msg time).
                    const ea = a.activity || 0, eb = b.activity || 0;
                    if (ea !== eb) return eb - ea;
                    return metaA.name.localeCompare(metaB.name);
                }
                case 'activity-asc': {
                    const ea = a.activity || 0, eb = b.activity || 0;
                    if (ea !== eb) return ea - eb;
                    return metaA.name.localeCompare(metaB.name);
                }

                case 'name-asc': return metaA.name.localeCompare(metaB.name);
                case 'name-desc': return metaB.name.localeCompare(metaA.name);

                case 'date-asc': return metaA.date - metaB.date;
                case 'date-desc': return metaB.date - metaA.date;

                case 'size-asc': return metaA.size - metaB.size;
                case 'size-desc': return metaB.size - metaA.size;

                case 'count-asc': return metaA.msgCount - metaB.msgCount;
                case 'count-desc': return metaB.msgCount - metaA.msgCount;

                default: return 0; // Native order
            }
        });
    }

    // ========== SYNC ENGINE ==========

    function scheduleSync() {
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        // Increased to 200ms to prevent UI lag
        syncDebounceTimer = setTimeout(performSync, 200);
    }

    // Lazy Loading Helper (Append Only)
    // Lazy Loading Helper (Append Only)
    function renderBatch(folderId, startIndex, count, containerElement = null, searchTerm = '') {
        const container = containerElement || document.querySelector(`.tmc_section[data-id="${escAttr(folderId)}"] .tmc_content`);
        if (!container) return;

        const chats = chatsByFolder[folderId] || [];
        // v0.13.0: main view truncates MANUAL folders to 3 rows — apply the
        // cap BEFORE building DOM. The old flow rendered the full batch
        // (20+ proxy blocks per folder, each an innerHTML copy) and then
        // immediately deleted everything past 3, on every single sync.
        const isFamily = String(folderId).startsWith('family::');
        const mainTruncated = currentView === 'main' && folderId !== 'uncategorized' && !isFamily;
        const endIndex = mainTruncated
            ? Math.min(startIndex + count, chats.length, 3)
            : Math.min(startIndex + count, chats.length);

        // Remove old sentinel if exists
        const oldSentinel = container.querySelector('.tmc_sentinel');
        if (oldSentinel) oldSentinel.remove();

        const fragment = document.createDocumentFragment();

        for (let i = startIndex; i < endIndex; i++) {
            const chat = chats[i];
            const isPinned = isPinnedFile(chat.fileName);
            const proxy = createProxyBlock(chat, isPinned, searchTerm);
            fragment.appendChild(proxy);
        }

        container.appendChild(fragment);

        // Remember how deep this section has been rendered (see renderedCounts).
        renderedCounts[folderId] = Math.max(renderedCounts[folderId] || 0, endIndex);

        // v0.7.0: scroll the open chat into view, once per popup open. If the
        // block gets removed before the frame renders (main view truncates
        // folders to 3 items right after this), release the flag so a later
        // render that actually shows it (e.g. folder view) can still scroll.
        if (!activeScrolledThisOpen) {
            const activeEl = container.querySelector('.tmc_active');
            if (activeEl) {
                activeScrolledThisOpen = true;
                requestAnimationFrame(() => {
                    if (activeEl.isConnected) {
                        activeEl.scrollIntoView({ block: 'center' });
                    } else {
                        activeScrolledThisOpen = false;
                    }
                });
            }
        }

        // Update counts
        const section = container.closest('.tmc_section');
        const badge = section.querySelector('.tmc_count');
        if (badge) badge.textContent = chats.length;

        // Truncation logic for Main View (Strict 3 items).
        // v0.10.0: applies to MANUAL folders only — a family section's entire
        // purpose is showing the full ordered lineage, so families are exempt
        // and use the lazy-load sentinel like the uncategorized list instead.
        // v0.13.0: the cap is applied via endIndex above, so nothing is
        // built just to be torn down — this block only adds the Show More row.
        if (mainTruncated) {
            if (chats.length > 3 && !container.querySelector('.tmc_show_more')) {
                const showMore = document.createElement('div');
                showMore.className = 'tmc_show_more';
                showMore.innerHTML = `<i class="fa-solid fa-ellipsis"></i> Show more (${chats.length - 3} more)`;
                showMore.addEventListener('click', (e) => {
                    e.stopPropagation();
                    currentView = 'folder';
                    viewFolderId = folderId;
                    scheduleSync();
                });
                container.appendChild(showMore);
            }
            return;
        }

        // Observer for Infinite Scroll.
        // Runs in dedicated Folder View, AND for the Uncategorized ("Your chats") list
        // in Main View, since that list is never truncated to 3 items and therefore
        // needs its own way to keep loading more than the initial BATCH_SIZE.
        if ((currentView === 'folder' || folderId === 'uncategorized' || isFamily) && endIndex < chats.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'tmc_sentinel'; // sized/styled in style.css
            sentinel.textContent = 'Loading…';
            sentinel.setAttribute('data-folder-id', folderId);
            sentinel.setAttribute('data-next-index', endIndex.toString());
            container.appendChild(sentinel);

            if (lazyObserver) lazyObserver.observe(sentinel);
        }
    }

    function initIntersectionObserver(rootEl = null) {
        if (lazyObserver) lazyObserver.disconnect();

        lazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const sentinel = entry.target;
                    const folderId = sentinel.getAttribute('data-folder-id');
                    const nextIndexStr = sentinel.getAttribute('data-next-index');
                    const nextIndex = nextIndexStr ? parseInt(nextIndexStr, 10) : NaN;

                    if (folderId && !isNaN(nextIndex)) {
                        // CRITICAL: Unobserve immediately to prevent double-firing
                        lazyObserver.unobserve(sentinel);
                        // Add small delay to smooth out rapid scrolling
                        setTimeout(() => {
                            // v0.13.1: continuation batches must carry the
                            // active search term, or rows lazy-loaded past
                            // the first slab lose their title highlight and
                            // context snippets mid-search.
                            renderBatch(folderId, nextIndex, BATCH_SIZE, null, lastSearchTermSeen);
                        }, 50);

                    }
                }
            });
        // Root the observer on the actual scrolling container (the popup body),
        // not on #tmc_proxy_root, which has no overflow/scroll of its own and
        // therefore can't reliably act as an IntersectionObserver root.
        }, { root: rootEl || null, rootMargin: '300px' });
    }


    function performSync() {
        // Only sync if user has opened the panel
        if (!userOpenedPanel) return;

        try {
            const popups = [
                document.querySelector('#shadow_select_chat_popup'),
                document.querySelector('#select_chat_popup')
            ];

            const popup = popups.find(p => p && getComputedStyle(p).display !== 'none');
            if (!popup) return;

            // v0.8.1: moved BEHIND the popup-visible gate. Previously this sat
            // at the top of performSync, so any sync scheduled while the popup
            // was closed (mutations, CHAT_CHANGED) could still trigger the
            // full-library /recent scan every TTL window during normal RP.
            // Now it can only fire while the user is actually looking at the
            // chat list. Fire-and-forget; completion schedules a re-render.
            refreshActivityData();

            const nativeBlocks = Array.from(popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)'));

            // v0.11.0 PERF: snapshot the stamp map ONCE per sync. Previously the
            // activity sort called getLastActive() inside the comparator —
            // getSettings() (context fetch + schema backfill) + key building per
            // COMPARISON, ~n·log(n) times per render.
            const laMap = getSettings().lastActive || {};
            const laPrefix = String(getCurrentCharacterId() ?? '?') + '::';

            const chatData = nativeBlocks.map(block => {
                const fileName = block.getAttribute('file_name') || block.title || block.innerText.split('\n')[0].trim();

                // Perf: this map runs on every sync, including once per
                // keystroke while searching. Re-parsing dates/sizes/counts
                // via regex and re-copying full innerHTML for every block
                // on every keystroke is the main source of typing jank.
                // Reuse is decided by reuseCachedNative() — see that
                // function for why element identity alone stopped being
                // enough on current ST (search rebuilds every block).
                const cached = nativeDataCache[fileName];
                if (reuseCachedNative(cached, block)) {
                    // activity must be recomputed EVERY sync even on cache hits:
                    // stamps move whenever the user opens/messages a chat, and
                    // cached metadata must never freeze the sort key.
                    cached.activity = Math.max(
                        laMap[laPrefix + fileName.replace(/\.jsonl$/i, '')] || 0,
                        (cached.metadata && cached.metadata.date) || 0);
                    return cached;
                }

                // v0.14.0: a three-method date-string extraction used to run
                // here on every fresh block parse (i.e. on every search
                // keystroke, per block) purely to fill `data.date` — a
                // human-formatted string that NOTHING ever read. The only
                // date anything consumes is the numeric one in
                // `metadata.date`; its fallbacks now live in
                // resolveBlockDate, where they are actually used.
                const data = {
                    element: block,
                    signature: block.textContent,
                    fileName,
                    title: extractChatTitle(fileName),
                    html: block.innerHTML, // Full native content with buttons
                    metadata: getChatMetadata(block, fileName)
                };
                data.activity = Math.max(
                    laMap[laPrefix + fileName.replace(/\.jsonl$/i, '')] || 0,
                    (data.metadata && data.metadata.date) || 0);
                nativeDataCache[fileName] = data;
                return data;
            }).filter(d => d.fileName);

            // Capture Search Term (one canonical resolver — see findSearchInput)
            const searchBar = findSearchInput(popup);
            const searchTerm = searchBar instanceof HTMLInputElement ? searchBar.value.trim().toLowerCase() : '';

            // FIX: The proxy list previously never reacted to typing, because
            // the MutationObserver only watches for specific target ids/classes
            // and added nodes - it does not catch style/attribute changes on
            // individual native chat blocks (which is how ST hides non-matches
            // when you search). Binding directly to the input event is the
            // reliable fix; the MutationObserver logic below stays as a
            // secondary safety net for other DOM changes.
            if (searchBar instanceof HTMLInputElement && !searchBar.dataset.tmcBound) {
                searchBar.dataset.tmcBound = '1';
                searchBar.addEventListener('input', () => {
                    scheduleSync();
                });
            }

            // Changing the search term is a NEW list — rendered depths from the
            // previous term must not carry over.
            if (searchTerm !== lastSearchTermSeen) {
                renderedCounts = {};
                lastSearchTermSeen = searchTerm;
            }

            // Apply Logic: Sort (Global or Folder-specific if we want, presently Global setting)
            const sortedData = sortChats(chatData);

            // v0.13.0: visibility is decided ONCE, upstream, and everything
            // downstream (family clustering, distribution, counts) sees the
            // same filtered list. On current ST, search re-fetches and
            // rebuilds the native list so non-matches are simply absent; on
            // older builds ST hid them via inline display — honor both.
            const visibleData = sortedData.filter(chat =>
                !(chat.element && chat.element.style && chat.element.style.display === 'none'));

            let proxyRoot = popup.querySelector('#tmc_proxy_root');
            if (!proxyRoot) {
                proxyRoot = document.createElement('div');
                proxyRoot.id = 'tmc_proxy_root';

                const searchBarEl = findSearchInput(popup);

                if (searchBarEl && searchBarEl.parentNode) {
                    const searchContainer = searchBarEl.closest('.shadow_select_chat_popup_header') || searchBarEl.parentNode;
                    if (searchContainer.nextSibling) {
                        searchContainer.parentNode.insertBefore(proxyRoot, searchContainer.nextSibling);
                    } else {
                        searchContainer.parentNode.appendChild(proxyRoot);
                    }
                } else {
                    popup.insertBefore(proxyRoot, popup.firstChild);
                }
            }

            // The one true scroll container for the proxy list. Resolved AFTER
            // proxyRoot exists, and used by BOTH consumers below (lazy-load
            // observer root, scroll preservation) so they can never disagree.
            const scroller = getScrollContainer(popup, proxyRoot);

            // CARDS BROWSER (v0.12.0): a cross-card surface; replaces the
            // per-card tree entirely while active.
            if (cardsMode) {
                refreshCardsData();
                renderCardsTree(proxyRoot);
                injectAddButton(popup);
                // Cards mode returns early, so it must paint the header itself
                // — this is the branch where the Cards toggle actually goes ON.
                refreshHeaderState(popup);
                // v0.16.0 FAIL-SAFE: style.css parks ST's native chat list
                // off-screen ONLY under body.tmc-live. The class is added
                // exclusively on render paths that completed, so an extension
                // whose JS died before ever rendering leaves the class unset,
                // the hiding rules inert, and the user a fully working native
                // chat list instead of an empty popup.
                document.body.classList.add('tmc-live');
                // A different list entirely: don't hand its scroll offset back
                // to the per-card tree when we leave.
                lastListIdentity = 'cards';
                return;
            }

            const newTree = document.createDocumentFragment();
            const characterId = getCurrentCharacterId();
            const settings = getSettings();

            if (!characterId) {
                proxyRoot.innerHTML = '<div style="padding:12px;opacity:0.6">Select a character</div>';
                lastSyncedCharacterId = null;
                // v0.16.0 FAIL-SAFE — the proxy is functional here too.
                document.body.classList.add('tmc-live');
                return;
            }

            // If the active character changed since we last rendered the proxy tree,
            // any leftover folder-view / bulk-selection state belongs to the old
            // character and must be reset so it doesn't leak into the new one.
            if (characterId !== lastSyncedCharacterId) {
                currentView = 'main';
                viewFolderId = null;
                activeScrolledThisOpen = false;
                // v0.8.1: element-identity checks make stale entries inert, but
                // they still pile up across characters — drop them wholesale.
                nativeDataCache = {};
                renderedCounts = {};
                if (bulkMode || selectedChats.size > 0) {
                    bulkMode = false;
                    selectedChats.clear();
                    updateBulkBar();
                }
            }
            lastSyncedCharacterId = characterId;

            const folderContents = {};
            const folderIds = settings.characterFolders[characterId] || [];

            // VIEW LOGIC SWITCH
            // v0.10.0: family mode is a flat alternate organization of main
            // view (no folder drill-down), so force back out of folder view.
            const familyMode = !!settings.familyView;
            if (familyMode && currentView === 'folder') {
                currentView = 'main';
                viewFolderId = null;
            }
            // Chat-id -> section-id map used by the distribution loop below
            // when family mode is active (null otherwise).
            let familyFidByChat = null;

            if (currentView === 'folder' && viewFolderId && settings.folders[viewFolderId]) {
                // RENDER FOLDER VIEW
                const folder = settings.folders[viewFolderId];
                const section = createFolderViewDOM(viewFolderId, folder);
                newTree.appendChild(section);
                folderContents[viewFolderId] = section.querySelector('.tmc_content');
            } else if (familyMode) {
                // RENDER FAMILY VIEW: one section per branch lineage (root
                // parent + all its branches, transitively), in order of the
                // family's most recently active member (sortedData order),
                // then everything else under "Other chats". Scoped — like all
                // of TMC — to the current character card only.
                const sortedIds = visibleData.map(c => c.fileName.replace(/\.jsonl$/i, ''));
                const clusters = familyClusters(sortedIds, resolveFamilyRoot);
                familyFidByChat = {};

                for (const root of clusters.order) {
                    const fid = 'family::' + root;
                    for (const id of clusters.members[root]) familyFidByChat[id] = fid;
                    const section = createFamilyDOM(root, clusters.members[root].length, clusters.members[root]);
                    newTree.appendChild(section);
                    folderContents[fid] = section.querySelector('.tmc_content');
                }

                const uncatSection = createUncategorizedDOM('Other chats');
                newTree.appendChild(uncatSection);
                folderContents['uncategorized'] = uncatSection.querySelector('.tmc_content');
            } else {
                // RENDER MAIN VIEW
                // Reset view if invalid
                if (currentView === 'folder') {
                    currentView = 'main';
                    viewFolderId = null;
                }

                folderIds.forEach(fid => {
                    const folder = settings.folders[fid];
                    if (!folder) return;
                    const section = createFolderDOM(fid, folder);
                    newTree.appendChild(section);
                    folderContents[fid] = section.querySelector('.tmc_content');
                });

                const uncatSection = createUncategorizedDOM();
                newTree.appendChild(uncatSection);
                folderContents['uncategorized'] = uncatSection.querySelector('.tmc_content');
            }


            // Always (re)root the observer on the real scrolling container. Sentinels
            // are recreated every sync anyway, so this is cheap and keeps the root
            // correct even if the popup element instance changes.
            initIntersectionObserver(scroller);

            // Populate chatsByFolder memory store
            chatsByFolder = {};
            // Initialize with empty arrays for all known sections
            Object.keys(folderContents).forEach(fid => chatsByFolder[fid] = []);

            // Distribute chats into folders
            // Use sortedData instead of chatData
            visibleData.forEach(chat => {
                const chatId = chat.fileName.replace(/\.jsonl$/i, '');
                const fid = familyFidByChat
                    ? (familyFidByChat[chatId] || 'uncategorized')
                    : getFolderForChat(chat.fileName);

                // If in folder view, only process valid chats
                if (currentView === 'folder' && fid !== viewFolderId) return;

                if (!chatsByFolder[fid]) chatsByFolder[fid] = [];
                chatsByFolder[fid].push(chat);
            });

            // Pins float to the top of their section without inverting
            // their relative order (see partitionPinned).
            Object.keys(chatsByFolder).forEach(fid => {
                chatsByFolder[fid] = partitionPinned(chatsByFolder[fid], c => isPinnedFile(c.fileName));
            });

            // Initial Render Batch for each visible section
            Object.keys(folderContents).forEach(fid => {
                const count = chatsByFolder[fid] ? chatsByFolder[fid].length : 0;
                if (count > 0) {
                    // console.log(`[TMC] Rendering folder ${fid}: ${count} chats`); 
                }

                const container = folderContents[fid];
                const section = container.closest('.tmc_section');

                // Hide empty sections: the uncategorized list always (an
                // empty "Your chats" header is dead weight), and during an
                // active search EVERY empty section — a wall of zero-count
                // folder/family headers between the user and their matches
                // is noise; folders are only useful as drop targets when
                // NOT searching (v0.13.0).
                const sectionCount = chatsByFolder[fid] ? chatsByFolder[fid].length : 0;
                // v0.13.1: NEVER in folder view — that view has exactly one
                // section and its header IS the navigation (Back button).
                // Hiding it on a zero-match search left a blank panel with
                // no way back.
                if (currentView !== 'folder' && (fid === 'uncategorized' || searchTerm)) {
                    section.style.display = sectionCount > 0 ? '' : 'none';
                }

                // v0.13.1: search is a transient lens — matches inside a
                // collapsed folder/family must be VISIBLE while a term is
                // active (the header count said "3" while the rows sat at
                // display:none). Forced open for this render only; the
                // persisted collapsed flag is untouched, so clearing the
                // search restores the user's collapse state exactly.
                if (searchTerm && sectionCount > 0) {
                    container.style.display = '';
                    section.dataset.collapsed = 'false';
                }


                // Render first batch synchronously.
                // v0.8.1: during search this used to render EVERY match at
                // once, and each rendered block kicks a content fetch for its
                // context snippet — with a large library one keystroke could
                // fan out into hundreds of full-chat downloads. Cap the
                // initial slab; the scroll sentinel lazy-loads the rest.
                const sectionLen = chatsByFolder[fid] ? chatsByFolder[fid].length : 0;
                const initialBatchSize = searchTerm
                    ? Math.min(sectionLen, Math.max(30, renderedCounts[fid] || 0))
                    : Math.max(BATCH_SIZE, Math.min(renderedCounts[fid] || 0, sectionLen));

                renderBatch(fid, 0, initialBatchSize, container, searchTerm);
            });

            // Preserve the list's scroll position across the rebuild — but
            // only when the rebuild is showing the SAME list. Emptying
            // proxyRoot collapses scrollHeight, which clamps scrollTop to 0,
            // so the value has to be captured before and restored after.
            // v0.14.0: `scroller` is the element that actually scrolls (this
            // used to read #shadow_select_chat_popup, whose scrollTop is
            // permanently 0 — so the restore never ran and every background
            // resync threw the user back to the top of the list).
            const listId = [
                characterId, currentView, viewFolderId || '',
                familyMode ? 'fam' : 'flat', searchTerm
            ].join('\u0001');
            const sameList = listId === lastListIdentity;
            lastListIdentity = listId;
            lastScrollTop = sameList ? (scroller.scrollTop || 0) : 0;
            proxyRoot.innerHTML = '';
            proxyRoot.appendChild(newTree);
            scroller.scrollTop = lastScrollTop;

            injectAddButton(popup);
            refreshHeaderState(popup);
            // v0.16.0 FAIL-SAFE — see the cards-mode branch above: the native
            // list is only hidden once this render has actually succeeded.
            document.body.classList.add('tmc-live');

        } catch (err) {
            console.error('[TMC] Sync Error:', err);
        }
    }

    function createFolderDOM(fid, folder) {
        const section = document.createElement('div');
        section.className = 'tmc_section';
        section.dataset.id = fid;
        section.dataset.collapsed = folder.collapsed ? 'true' : 'false';

        // v0.7.0: dot on folders holding the open chat, so it's findable even
        // when collapsed or truncated to 3 items in main view.
        if (Array.isArray(folder.chats) && folder.chats.some(f => isActiveChatFile(f))) {
            section.classList.add('tmc_has_active');
        }

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_toggle"><i class="fa-solid fa-chevron-down"></i></span>
                <span class="tmc_icon"><i class="fa-solid fa-folder"></i></span>
                <span class="tmc_name">${escapeHtml(folder.name)}</span>
                <span class="tmc_count">0</span>
            </div>
            <div class="tmc_header_right">
                <span class="tmc_btn tmc_color" title="Color"><i class="fa-solid fa-palette"></i></span>
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
                <span class="tmc_btn tmc_del" title="Delete"><i class="fa-solid fa-trash"></i></span>
            </div>
        `;

        // Apply Color
        if (folder.color) {
            // It could be a key or a raw hex
            const c = FOLDER_COLORS[folder.color] || folder.color;
            if (c && c !== 'transparent') {
                header.style.borderLeft = `4px solid ${c}`;
                header.style.background = `${c}22`; // Low opacity background
            }
        }

        // Hidden color input - must use visibility:hidden, not display:none for clicks to work reliably
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.style.cssText = 'visibility: hidden; position: absolute; width: 0; height: 0; pointer-events: none;';
        colorInput.value = (folder.color && FOLDER_COLORS[folder.color] && FOLDER_COLORS[folder.color] !== 'transparent')
            ? FOLDER_COLORS[folder.color]
            : '#ffffff';

        section.appendChild(colorInput);

        header.querySelector('.tmc_color').onclick = (e) => {
            e.stopPropagation();
            colorInput.click();
        };

        colorInput.onchange = (e) => {
            // WE need to save the custom HEX or map it to closest? 
            // The prompt asked for keys (red, blue). 
            // User requested "picker". 
            // We should support custom hexes in setFolderColor now.
            // But FOLDER_COLORS is a map.
            // Let's modify setFolderColor to handle direct hex or extend the map?
            // Easiest: Just use the hex directly if it doesn't match a key.
            const val = e.target.value;
            setFolderColor(fid, val);
        };

        header.querySelector('.tmc_header_left').onclick = () => {
            const s = getSettings();
            if (s.folders[fid]) {
                s.folders[fid].collapsed = !s.folders[fid].collapsed;
                saveSettings();
                scheduleSync();
            }
        };

        header.querySelector('.tmc_edit').onclick = (e) => {
            e.stopPropagation();
            const n = prompt('Rename:', folder.name);
            if (n) renameFolder(fid, n);
        };

        header.querySelector('.tmc_del').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${folder.name}"?`)) deleteFolder(fid);
        };

        const content = document.createElement('div');
        content.className = 'tmc_content';
        content.style.display = folder.collapsed ? 'none' : '';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    function createFolderViewDOM(fid, folder) {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_folder_view';
        section.dataset.id = fid;

        const header = document.createElement('div');
        header.className = 'tmc_header tmc_folder_view_header';
        header.innerHTML = `
            <div class="tmc_header_left" style="cursor: default;">
                <span class="tmc_back_btn" title="Back"><i class="fa-solid fa-arrow-left"></i></span>
                <span class="tmc_icon"><i class="fa-solid fa-folder-open"></i></span>
                <span class="tmc_name">${escapeHtml(folder.name)}</span>
                <span class="tmc_count">0</span>
            </div>
             <div class="tmc_header_right">
                <span class="tmc_btn tmc_color" title="Color"><i class="fa-solid fa-palette"></i></span>
                <span class="tmc_btn tmc_edit" title="Rename"><i class="fa-solid fa-pencil"></i></span>
            </div>
        `;

        // Apply Color in header
        if (folder.color) {
            const c = FOLDER_COLORS[folder.color] || folder.color;
            if (c && c !== 'transparent') {
                header.style.borderLeft = `4px solid ${c}`;
                header.style.background = `${c}22`;
            }
        }

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.style.cssText = 'visibility: hidden; position: absolute; width: 0; height: 0; pointer-events: none;';
        colorInput.value = (folder.color && FOLDER_COLORS[folder.color] && FOLDER_COLORS[folder.color] !== 'transparent') ? FOLDER_COLORS[folder.color] : '#ffffff';
        section.appendChild(colorInput);

        header.querySelector('.tmc_color').onclick = (e) => { e.stopPropagation(); colorInput.click(); };
        colorInput.onchange = (e) => { setFolderColor(fid, e.target.value); };

        header.querySelector('.tmc_back_btn').onclick = (e) => {
            e.stopPropagation();
            currentView = 'main';
            viewFolderId = null;
            scheduleSync();
        };

        header.querySelector('.tmc_edit').onclick = (e) => {
            e.stopPropagation();
            const n = prompt('Rename:', folder.name);
            if (n) renameFolder(fid, n);
        };

        const content = document.createElement('div');
        content.className = 'tmc_content';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    function createFamilyDOM(root, memberCount, members = null) {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_family';
        section.dataset.id = 'family::' + root;

        const collapsed = !!getSettings().familyCollapsed?.[familyCollapseKey(root)];
        section.dataset.collapsed = collapsed ? 'true' : 'false';

        // v0.13.0: the dot means "the OPEN chat lives in here" — true when
        // ANY member (root or branch) is open, not just the root.
        const dotIds = (Array.isArray(members) && members.length) ? members : [root];
        if (dotIds.some(id => isActiveChatFile(id))) {
            section.classList.add('tmc_has_active');
        }

        const header = document.createElement('div');
        header.className = 'tmc_header tmc_family_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_toggle"><i class="fa-solid fa-chevron-down"></i></span>
                <span class="tmc_icon"><i class="fa-solid fa-code-branch"></i></span>
                <span class="tmc_name">${escapeHtml(root)}</span>
                <span class="tmc_count">${memberCount}</span>
            </div>
        `;

        header.onclick = () => {
            const s = getSettings();
            if (!s.familyCollapsed) s.familyCollapsed = {};
            const key = familyCollapseKey(root);
            s.familyCollapsed[key] = !s.familyCollapsed[key];
            saveSettings();
            scheduleSync();
        };

        const content = document.createElement('div');
        content.className = 'tmc_content';
        content.style.display = collapsed ? 'none' : '';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

    function createUncategorizedDOM(label = 'Your chats') {
        const section = document.createElement('div');
        section.className = 'tmc_section tmc_uncat';
        section.dataset.id = 'uncategorized';

        const header = document.createElement('div');
        header.className = 'tmc_header';
        header.innerHTML = `
            <div class="tmc_header_left">
                <span class="tmc_icon"><i class="fa-regular fa-comments"></i></span>
                <span class="tmc_name">${escapeHtml(label)}</span>
                <span class="tmc_count">0</span>
            </div>
        `;

        const content = document.createElement('div');
        content.className = 'tmc_content';

        section.appendChild(header);
        section.appendChild(content);
        return section;
    }

      // Proxy block with FULL native content (buttons, preview, etc.)
    function createProxyBlock(chatData, isPinned, searchTerm = '') {
        const el = document.createElement('div');
        el.className = 'select_chat_block tmc_proxy_block';

        // Shared preview-fetch budget (v0.11.0): don't download very large
        // chats just for a preview snippet — the native preview stays. 4MB is
        // already a serious JSON.parse on a phone's main thread.
        const ENRICH_MAX_BYTES = 4 * 1024 * 1024;
        if (isPinned) el.classList.add('tmc_pinned');

        // Use full native HTML content (includes preview, buttons, etc.)
        el.innerHTML = chatData.html;



        el.title = chatData.fileName;
        el.setAttribute('file_name', chatData.fileName);

        // Render Pin Visual
        if (isPinned) {
            const pinIcon = document.createElement('span');
            pinIcon.className = 'tmc_pin_icon';
            pinIcon.textContent = '📌';

            // Insert before title or at start
            const titleEl = getTitleEl(el);
            if (titleEl) {
                titleEl.prepend(pinIcon);
            } else {
                el.prepend(pinIcon);
            }
        }

        // SEARCH HIGHLIGHTING
        if (searchTerm) {
            const titleEl = getTitleEl(el);
            if (titleEl) {
                // v0.14.0: applyHighlight rebuilds the title as text nodes +
                // highlight spans (see splitHighlight). It clears the element,
                // which drops the pin icon prepended above — so the pin is
                // re-prepended right after, exactly as before.
                applyHighlight(titleEl, chatData.title, searchTerm);
                if (isPinned) {
                    const pinIcon = document.createElement('span');
                    pinIcon.className = 'tmc_pin_icon';
                    pinIcon.textContent = '📌';
                    titleEl.prepend(pinIcon);
                }
            }

            // CONTEXTUAL PREVIEW: replace the (always-last-message) preview
            // text with a snippet of context around where the search term
            // actually appears in the chat, instead of the last message.
            if (((chatData.metadata && chatData.metadata.size) || 0) <= ENRICH_MAX_BYTES) {
                enrichPreviewWithContext(el, chatData.fileName, searchTerm, titleEl);
            }
        }

        // BEGINNING PREVIEW (v0.15.0 ROOT FIX): ST's /api/chats/search builds
        // each row's preview as the TAIL of the last message (server-side
        // getPreviewMessage: '…' + the final 400 chars), so every row was
        // identified by the random END of the last output. ST's own Recent
        // Chats panel leads with the message's BEGINNING — restore that here.
        // While a search term is active the contextual match snippet is the
        // more useful text, so it wins; oversized chats keep the native
        // preview rather than being downloaded for cosmetics.
        if (!searchTerm && ((chatData.metadata && chatData.metadata.size) || 0) <= ENRICH_MAX_BYTES) {
            enrichPreviewWithBeginning(el, chatData.fileName, getTitleEl(el));
        }

        // BRANCH CHIP (v0.8.0): parentage comes from chat_metadata.main_chat
        // via the activity fetch — real data, not filename pattern matching,
        // so renamed branches are covered too. textContent/title assignment
        // only; no HTML injection surface.
        const branchParent = getBranchParent(chatData.fileName);
        if (branchParent) {
            const bchip = document.createElement('span');
            bchip.className = 'tmc_branch_chip';
            bchip.textContent = '\u21B3 branch';
            bchip.title = 'Branch of: ' + branchParent;
            const bTitleEl = getTitleEl(el);
            if (bTitleEl) {
                bTitleEl.appendChild(bchip);
            } else {
                el.prepend(bchip);
            }
        }

        // ACTIVITY HINT (v0.12.1): when the invisible interaction stamp is
        // what ranks this chat (it exceeds the visible last-message date),
        // say so — otherwise the Active sort looks wrong next to the dates.
        const shownDate = (chatData.metadata && chatData.metadata.date) || 0;
        if (chatData.activity && chatData.activity > shownDate + 60000) {
            const hint = document.createElement('span');
            hint.className = 'tmc_activity_hint';
            hint.textContent = '⏱ active ' + formatRelativeTime(chatData.activity);
            hint.title = 'Last time you opened or messaged this chat — this is what the Active sort uses';
            const hTitleEl = getTitleEl(el);
            if (hTitleEl) hTitleEl.appendChild(hint); else el.prepend(hint);
        }

        // ACTIVE CHAT MARKER (v0.7.0)
        // Runs AFTER search highlighting on purpose: the highlight path
        // rewrites titleEl.innerHTML, which would wipe a chip added earlier.
        if (isActiveChatFile(chatData.fileName)) {
            el.classList.add('tmc_active');
            const chip = document.createElement('span');
            chip.className = 'tmc_active_chip';
            chip.textContent = 'Open';
            const titleEl = getTitleEl(el);
            if (titleEl) {
                titleEl.appendChild(chip);
            } else {
                el.prepend(chip);
            }
        }

        // BULK MODE VISUALS
        if (bulkMode) {
            const check = document.createElement('div');
            check.className = 'tmc_bulk_check';
            check.innerHTML = selectedChats.has(chatData.fileName) ? '<i class="fa-solid fa-square-check"></i>' : '<i class="fa-regular fa-square"></i>';
            el.prepend(check);

            if (selectedChats.has(chatData.fileName)) {
                el.classList.add('tmc_selected');
            }
        }

        // Move pencil icon to the right side with other action buttons
        const pencilBtn = el.querySelector('.renameChatButton');
        const actionContainer = el.querySelector('.flex-container.gap10px') ||
            el.querySelector('[class*="action"]') ||
            el.querySelector('.select_chat_info')?.parentElement;
        if (pencilBtn && actionContainer) {
            // Move pencil to the action container (right side)
            actionContainer.insertBefore(pencilBtn, actionContainer.firstChild);
        }



        // MOBILE MENU: Add context menu button (kebab)
        const menuBtn = document.createElement('div');
        menuBtn.className = 'tmc_mobile_menu';
        menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showContextMenu(e, chatData.fileName);
        });
        el.appendChild(menuBtn);

        // Intercept main click (not on buttons)
        el.addEventListener('click', (e) => {
            // Don't intercept if clicking on action buttons
            // Improve Selector specificity
            // v0.11.0: .PastChat_cross/.fa-skull added — without them, tapping the
            // native delete skull on a PROXY row matched nothing here, fell through
            // to the load-chat path, and OPENED the chat instead of deleting it.
            const target = e.target.closest('button, .mes_button, .renameChatButton, .PastChat_cross, .fa-skull, .select_chat_block_action, .mes_edit, .mes_delete, .mes_export, [class*="export"], [class*="delete"], [class*="download"]');

            if (target) {
                e.stopPropagation();
                // Try to find matching button in original element by specific class
                // Map common classes to selectors
                const classList = target.classList;
                let selector = '';

                if (classList.contains('mes_delete') || classList.contains('fa-trash') || classList.contains('fa-skull') || classList.contains('PastChat_cross')) selector = '.PastChat_cross, .mes_delete, .fa-trash, .fa-skull, [class*="delete"]';
                else if (classList.contains('renameChatButton') || classList.contains('fa-pen')) selector = '.renameChatButton, .fa-pen';
                else if (classList.contains('mes_edit')) selector = '.mes_edit';
                else if (classList.contains('mes_export')) selector = '.mes_export';

                // Fallback: strict class matching on the first class that isn't
                // generic. v0.14.0: read classList, not className. On an SVG
                // element (FontAwesome's SVG-with-JS mode replaces every <i>
                // with an <svg>) className is an SVGAnimatedString, not a
                // string — truthy, so the old guard let it through, and
                // .split() threw inside the click handler. Every proxy row
                // button would have been silently dead on such a build.
                if (!selector && target.classList && target.classList.length) {
                    const parts = Array.from(target.classList)
                        .filter(c => c !== 'mes_button' && c !== 'fa-solid' && c !== 'fa');
                    if (parts.length > 0) selector = '.' + CSS.escape(parts[0]);
                }

                // v0.11.0: re-resolve the native block at CLICK time. ST rebuilds
                // the native list on every search keystroke, so the element we
                // captured at render time may be detached — click() on a detached
                // node is a silent no-op (briefly dead buttons).
                const liveNative = findNativeBlock(chatData.fileName) || chatData.element;
                if (selector) {
                    const originalBtn = liveNative.querySelector(selector);
                    if (originalBtn) {
                        originalBtn.click();
                        return;
                    }
                }
                return;
            }


            // BULK MODE LOGIC
            if (bulkMode) {
                e.stopPropagation();
                e.preventDefault();

                if (e.shiftKey && lastSelectedChat) {
                    // Range Selection
                    const allBlocks = Array.from(document.querySelectorAll('.tmc_proxy_block'));
                    const startIdx = allBlocks.findIndex(b => b.getAttribute('file_name') === lastSelectedChat);
                    const endIdx = allBlocks.findIndex(b => b.getAttribute('file_name') === chatData.fileName);

                    if (startIdx > -1 && endIdx > -1) {
                        const low = Math.min(startIdx, endIdx);
                        const high = Math.max(startIdx, endIdx);

                        for (let i = low; i <= high; i++) {
                            const fname = allBlocks[i].getAttribute('file_name');
                            if (fname) selectedChats.add(fname);
                        }
                    } else {
                        // Fallback if not found
                        if (selectedChats.has(chatData.fileName)) {
                            selectedChats.delete(chatData.fileName);
                        } else {
                            selectedChats.add(chatData.fileName);
                        }
                    }
                } else {
                    // Normal Toggle
                    if (selectedChats.has(chatData.fileName)) {
                        selectedChats.delete(chatData.fileName);
                    } else {
                        selectedChats.add(chatData.fileName);
                    }
                    lastSelectedChat = chatData.fileName;
                }

                scheduleSync(); // Re-render to show selection
                updateBulkBar();
                return;
            }

            // Otherwise load the chat (re-resolved: see liveNative note above)
            //
            // v0.15.0 ROOT FIX (double "Chat History — Loading chat…" banner):
            // current ST opens chat rows through a DOCUMENT-delegated handler
            // (bookmarks.js) matching '.select_chat_block[file_name]' — both
            // of which this proxy carries. The forwarded native click bubbles
            // to document and fires that handler once; WITHOUT
            // stopPropagation the proxy's own click then bubbles there too
            // and fires it AGAIN — two loader banners and two full chat loads
            // per click. So when a live native block exists it is the ONE open
            // path and this event goes no further. When the native block went
            // stale (ST rebuilds the list per search keystroke) there is
            // nothing live to forward to: a click on the detached node still
            // reaches handlers bound DIRECTLY to it (older ST), while the
            // un-stopped bubble reaches the delegated one (current ST) —
            // each build gets exactly one open.
            const openTarget = findNativeBlock(chatData.fileName) || chatData.element;
            if (openTarget && openTarget.isConnected) {
                e.stopPropagation();
                openTarget.click();
            } else if (openTarget) {
                openTarget.click();
            }
        });


        el.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e, chatData.fileName);
        };

        return el;
    }

    // v0.14.0 ROOT FIX: the header buttons are created ONCE (ST keeps the
    // popup markup alive between opens and just toggles display), so any
    // toggle state painted at creation time drifts the moment that state
    // changes anywhere else. Concretely: closing the popup resets cardsMode to
    // false in syncPanelVisibility, but the Cards button kept its
    // .tmc_toggle_on class — so it came back lit while showing the normal
    // per-card tree, and the next tap then turned Cards ON while removing the
    // highlight. Toggle state is no longer stored on the buttons: it is
    // reconciled from the real state on every sync, in one place.
    function refreshHeaderState(popup) {
        const cardsBtn = popup.querySelector('.tmc_cards_btn');
        if (cardsBtn) cardsBtn.classList.toggle('tmc_toggle_on', cardsMode);
        const famBtn = popup.querySelector('.tmc_family_btn');
        if (famBtn) {
            let famOn = false;
            try { famOn = !!getSettings().familyView; } catch { famOn = false; }
            famBtn.classList.toggle('tmc_toggle_on', famOn);
            // Families is a per-card organization of the current card's list;
            // it means nothing in the cross-card Cards browser.
            famBtn.classList.toggle('tmc_btn_muted', cardsMode);
        }
        const bulkBtn = popup.querySelector('.tmc_bulk_btn');
        if (bulkBtn) bulkBtn.classList.toggle('tmc_toggle_on', bulkMode);
        const sel = popup.querySelector('#tmc_sort_select');
        if (sel && sel.value !== sortOrder) sel.value = sortOrder;
    }

    function injectAddButton(popup) {
        if (popup.querySelector('.tmc_add_btn')) return;

        // FIX: Use correct selector - native SillyTavern uses [name="selectChatPopupHeader"]
        const headerRow = popup.querySelector('[name="selectChatPopupHeader"]') ||
            popup.querySelector('.flex-container.alignitemscenter') ||
            popup.querySelector('h3');
        if (!headerRow) {
            console.warn('[TMC] Could not find header row for New Folder button');
            return;
        }

        // New Folder Button
        const btn = document.createElement('div');
        btn.className = 'menu_button tmc_add_btn';
        btn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> New Folder';
        btn.title = 'Create New Folder';
        btn.onclick = (e) => {
            e.stopPropagation();
            const n = prompt('New Folder Name:');
            if (n) createFolder(n);
        };

        // Bulk Select Button
        const bulkBtn = document.createElement('div');
        bulkBtn.className = 'menu_button tmc_add_btn tmc_bulk_btn';
        bulkBtn.innerHTML = '<i class="fa-solid fa-list-check"></i> Select';
        bulkBtn.title = 'Select Multiple Chats';
        bulkBtn.onclick = (e) => {
            e.stopPropagation();
            bulkMode = !bulkMode;
            if (!bulkMode) selectedChats.clear();
            scheduleSync();
            updateBulkBar();
        };

        // CARDS BROWSER TOGGLE (v0.12.0)
        const cardsBtn = document.createElement('div');
        cardsBtn.className = 'menu_button tmc_add_btn tmc_cards_btn';
        cardsBtn.innerHTML = '<i class="fa-solid fa-address-book"></i> Cards';
        cardsBtn.title = 'Browse every character card\'s chats and jump between them';
        cardsBtn.onclick = (e) => {
            e.stopPropagation();
            cardsMode = !cardsMode;
            if (cardsMode) {
                refreshCardsData(true);
                // Bulk selection is a per-card surface; a floating bulk bar
                // over the cross-card browser is meaningless (v0.13.0).
                if (bulkMode || selectedChats.size > 0) clearSelection();
            }
            scheduleSync();
        };

        // JUMP TO OPEN CHAT (v0.11.0): the auto-scroll fires once per popup
        // open; this re-finds the OPEN row on demand — long lists, after
        // scrolling away, or after toggling views.
        const jumpBtn = document.createElement('div');
        jumpBtn.className = 'menu_button tmc_add_btn tmc_jump_btn';
        jumpBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
        jumpBtn.title = 'Scroll to the currently open chat';
        jumpBtn.onclick = (e) => {
            e.stopPropagation();
            jumpToOpenChat(popup);
        };

        // FAMILIES TOGGLE (v0.10.0): alternate organization of the current
        // character card's chats — one section per branch lineage (parent +
        // all its branches, ordered), everything else under "Other chats".
        const famBtn = document.createElement('div');
        famBtn.className = 'menu_button tmc_add_btn tmc_family_btn';
        famBtn.innerHTML = '<i class="fa-solid fa-code-branch"></i> Families';
        famBtn.title = 'Group this character\'s chats by branch lineage';
        famBtn.onclick = (e) => {
            e.stopPropagation();
            const s = getSettings();
            s.familyView = !s.familyView;
            saveSettings();
            scheduleSync(); // paints the toggle via refreshHeaderState
        };

        // SORT DROPDOWN
        const sortContainer = document.createElement('div');
        sortContainer.className = 'menu_button tmc_add_btn tmc_sort_btn';
        sortContainer.style.display = 'flex';
        sortContainer.style.alignItems = 'center';
        sortContainer.style.paddingLeft = '10px';
        sortContainer.style.position = 'relative'; // Ensure relative parent
        sortContainer.innerHTML = '<i class="fa-solid fa-arrow-down-wide-short"></i>';

        const sortSelect = document.createElement('select');
        sortSelect.id = 'tmc_sort_select';
        // Overlay fully with opacity 0 to ensure click capture
        sortSelect.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;';
        sortSelect.innerHTML = `
                <option value="activity-desc">Active (Recent)</option>
                <option value="activity-asc">Active (Oldest)</option>
                <option value="date-desc">Last Msg (New)</option>
                <option value="date-asc">Last Msg (Old)</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="count-desc">Msgs (Most)</option>
                <option value="count-asc">Msgs (Least)</option>
                <option value="size-desc">Size (Large)</option>
                <option value="size-asc">Size (Small)</option>
            `;
        sortSelect.value = sortOrder; // Set current
        sortContainer.title = 'Sort. "Active" = most recently modified file (branches float to top, like the Recent screen). "Last Msg" = date of the last message inside the chat (a branch of an old chat sorts next to its parent).';

        sortSelect.onchange = (e) => {
            sortOrder = e.target.value;
            // v0.8.0: persist across reloads
            getSettings().sortOrder = sortOrder;
            saveSettings();
            scheduleSync();
        };

        // Prevent popup close on click
        sortSelect.onclick = (e) => e.stopPropagation();

        sortContainer.appendChild(sortSelect);


        // Inject into the header row (found earlier)
        if (!headerRow.querySelector('.tmc_add_btn')) {
            headerRow.appendChild(sortContainer);
            headerRow.appendChild(cardsBtn);
            headerRow.appendChild(jumpBtn);
            headerRow.appendChild(famBtn);
            headerRow.appendChild(bulkBtn);
            headerRow.appendChild(btn);
        }
    }

    // v0.14.0: the jump button used to give up with "Open chat is not in the
    // current view" whenever the open chat was not currently RENDERED — which
    // is the common case, not an edge case: main view truncates every manual
    // folder to 3 rows, so the open chat sitting at position 7 of a folder was
    // simply unreachable by the button whose entire job is reaching it.
    // It now resolves where the chat lives and navigates there first, then
    // scrolls once the render lands. Cards mode is a cross-card browser with
    // no row for the open chat at all, so it steps out of it.
    function jumpToOpenChat(popup) {
        const flash = () => {
            const el = popup.querySelector('.tmc_proxy_block.tmc_active');
            if (!el) return false;
            const content = el.closest('.tmc_content');
            if (content && content.style.display === 'none') content.style.display = '';
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('tmc_flash');
            setTimeout(() => el.classList.remove('tmc_flash'), 1200);
            return true;
        };
        if (flash()) return;

        const active = getActiveChatName();
        if (!active) {
            if (typeof toastr !== 'undefined') toastr.info('No chat is open right now');
            return;
        }
        // Navigate to wherever it lives, then retry after the render.
        let moved = false;
        if (cardsMode) { cardsMode = false; moved = true; }
        const settings = getSettings();
        if (settings.familyView) {
            // Family sections are never truncated, so the row exists once the
            // holding section is expanded; clear its collapse flag.
            const root = resolveFamilyRoot(active);
            const key = familyCollapseKey(root);
            if (settings.familyCollapsed && settings.familyCollapsed[key]) {
                delete settings.familyCollapsed[key];
                saveSettings();
                moved = true;
            }
        } else {
            const fid = getFolderForChat(active);
            if (fid !== 'uncategorized' && !(currentView === 'folder' && viewFolderId === fid)) {
                currentView = 'folder';
                viewFolderId = fid;
                moved = true;
            } else if (fid === 'uncategorized' && currentView === 'folder') {
                currentView = 'main';
                viewFolderId = null;
                moved = true;
            }
        }
        if (!moved) {
            if (typeof toastr !== 'undefined') toastr.info('Open chat is not in this list');
            return;
        }
        // performSync is synchronous once scheduled; give the debounce room,
        // then scroll to the row it just rendered.
        performSync();
        if (!flash()) requestAnimationFrame(() => flash());
    }

    function updateBulkBar() {
        let bar = document.querySelector('#tmc_bulk_bar');
        if (!bulkMode) {
            if (bar) bar.remove();
            return;
        }

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'tmc_bulk_bar';
            document.body.appendChild(bar);
        }

        const count = selectedChats.size;
        bar.innerHTML = `
            <div class="tmc_bulk_info">${count} Selected</div>
            <div class="tmc_bulk_actions">
                <button id="tmc_bulk_move" ${count === 0 ? 'disabled' : ''}><i class="fa-solid fa-folder-open"></i> Move</button>
                <button id="tmc_bulk_movechar" ${count === 0 ? 'disabled' : ''}><i class="fa-solid fa-user-arrow-right"></i> To card</button>
                <button id="tmc_bulk_delete" class="tmc_bulk_delete_btn" ${count === 0 ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> Delete</button>
                <button id="tmc_bulk_cancel">Cancel</button>
            </div>
        `;

        bar.querySelector('#tmc_bulk_cancel').onclick = clearSelection;

        bar.querySelector('#tmc_bulk_move').onclick = (e) => {
            if (count === 0) return;
            showContextMenu(e, null, true); // true = bulk mode
        };

        bar.querySelector('#tmc_bulk_movechar').onclick = (e) => {
            if (count === 0) return;
            showCharacterPicker(e, Array.from(selectedChats));
        };

        bar.querySelector('#tmc_bulk_delete').onclick = async (e) => {
            if (count === 0) return;
            const chatCount = selectedChats.size;
            if (!confirm(`Delete ${chatCount} selected chat${chatCount !== 1 ? 's' : ''}? This cannot be undone.`)) return;

            const toDelete = Array.from(selectedChats);

            const context = SillyTavern.getContext();
            const characterId = context.characterId; // numeric index into context.characters[]
            const groupId = context.groupId;

            // v0.8.1 FIX: bulk delete previously required a numeric character
            // index and hard-errored in group chats. Groups now route through
            // ST's own deleteGroupChatByName, which also updates the group's
            // chats[] registry and switches away if the open chat was deleted.
            if (!groupId && (characterId === undefined || characterId === null)) {
                toastr.error('Could not determine current character — cannot delete.');
                return;
            }

            let deletedCount = 0;
            let fallbackNeeded = false;
            let skippedOpen = 0;

            // The open chat is deleted LAST and through a chat-aware path, so
            // ST is never left holding a file that no longer exists (see
            // partitionOpenChat).
            const { others, open } = partitionOpenChat(toDelete, isActiveChatFile);

            const dropNativeRow = (fileName) => {
                // The *ByName helpers bypass ST's own delete-button flow, so ST
                // never removes this chat's entry from the already-rendered
                // native popup list. Remove it ourselves, or the proxy tree
                // keeps mirroring a deleted chat until the popup is reopened.
                const originalBlock = findNativeBlock(fileName);
                if (originalBlock) originalBlock.remove();
            };

            try {
                if (groupId) {
                    const g = await import('/scripts/group-chats.js');
                    for (const fileName of others) {
                        try {
                            await g.deleteGroupChatByName(groupId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                        } catch (err) {
                            console.warn('[TMC] deleteGroupChatByName failed for:', fileName, err);
                        }
                    }
                    for (const fileName of open) {
                        // deleteGroupChat() clears chat metadata and jumps to a
                        // real chat; deleteGroupChatByName() does neither.
                        if (typeof g.deleteGroupChat !== 'function') { skippedOpen++; continue; }
                        try {
                            await g.deleteGroupChat(groupId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                        } catch (err) {
                            console.warn('[TMC] deleteGroupChat (open chat) failed for:', fileName, err);
                        }
                    }
                } else {
                    // ST's own helpers use getRequestHeaders() internally, so CSRF
                    // is handled for us. They take the name WITHOUT .jsonl.
                    const s = await import('/script.js');

                    for (const fileName of others) {
                        try {
                            await s.deleteCharacterChatByName(characterId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                        } catch (err) {
                            console.warn('[TMC] deleteCharacterChatByName failed for:', fileName, err);
                        }
                    }
                    for (const fileName of open) {
                        // Same teardown ST's own delete button performs: remove
                        // the file, then clear + reload into a real chat. Without
                        // replaceCurrentChat available we do NOT delete it —
                        // leaving the chat alive is always better than leaving ST
                        // pointed at a deleted one.
                        if (typeof s.replaceCurrentChat !== 'function') { skippedOpen++; continue; }
                        try {
                            await s.deleteCharacterChatByName(characterId, normalizeChatId(fileName));
                            deletedCount++;
                            dropNativeRow(fileName);
                            await s.replaceCurrentChat();
                        } catch (err) {
                            console.warn('[TMC] open-chat delete failed for:', fileName, err);
                        }
                    }
                }
            } catch (importErr) {
                console.warn('[TMC] Could not import ST delete function, trying fallback:', importErr);
                fallbackNeeded = true;
            }

            if (fallbackNeeded) {
                // Fallback if direct call won't work for some reason, just in case. This forces to press delete many times, but still better than waiting for page reloads.
                toastr.info('Using fallback deletion — you will be prompted once per chat.');
                for (const fileName of toDelete) {
                    const originalBlock = findNativeBlock(fileName);
                    const delBtn = originalBlock?.querySelector('.mes_delete') ||
                        originalBlock?.querySelector('.fa-skull') ||
                        originalBlock?.querySelector('[class*="delete"]');
                    if (delBtn) {
                        // v0.16.0: no deletedCount++ here — ST's own confirm
                        // dialog decides, and a cancelled confirmation used
                        // to be counted as a deletion (the success toast lied).
                        delBtn.click();
                        await new Promise(r => setTimeout(r, 80));
                    }
                }
            }

            // Clean up folder / pin / stamp references for deleted chats
            // via the canonical normalized cleanup (see
            // stripDeletedFromFolders for why raw includes() was broken).
            const settings = getSettings();
            const characterIdKey = getCurrentCharacterId();
            if (characterIdKey && stripDeletedFromFolders(settings, characterIdKey, toDelete)) {
                saveSettings();
            }

            if (deletedCount > 0 && !fallbackNeeded) {
                toastr.success(`Deleted ${deletedCount} chat${deletedCount !== 1 ? 's' : ''}`);
                scheduleSync();
            }
            // v0.16.0: a destructive operation must never fail silently. Every
            // per-chat failure above is only console.warn'd; if NOTHING was
            // deleted (import worked, but every helper call threw), the old
            // code showed no toast at all and the selection just vanished.
            if (deletedCount === 0 && !fallbackNeeded && toDelete.length > 0) {
                toastr.error(`Could not delete any of the ${toDelete.length} selected chat${toDelete.length !== 1 ? 's' : ''} — see browser console (F12) for details`);
            }
            if (skippedOpen) {
                toastr.warning(`Skipped ${skippedOpen} open chat — close or switch away from it first`);
            }

            clearSelection();
        };

    }

    // ========== CONTEXT MENU ==========

    function showContextMenu(e, fileName, isBulk = false) {
        // Cleanup existing menus properly
        document.querySelectorAll('.tmc_ctx').forEach(m => {
            if (m.cleanup) m.cleanup();
            m.remove();
        });

        const menu = document.createElement('div');
        menu.className = 'tmc_ctx';

        // Position centering if bulk
        if (isBulk) {
            menu.style.top = '50%';
            menu.style.left = '50%';
            menu.style.transform = 'translate(-50%, -50%)';
            menu.style.position = 'fixed';
            menu.style.maxHeight = '80vh';
            menu.style.overflowY = 'auto';
        } else {
            // .tmc_ctx is position:fixed — the correct coordinates are
            // client*, not page* (page* drifts by the scroll offset).
            // v0.13.0 ROOT FIX: place at the tap point, then CLAMP to the
            // viewport after append (clampMenuToViewport). The old
            // right-edge special case is subsumed; a kebab tap near the
            // bottom of a phone screen no longer pushes the menu off-screen.
            menu.style.top = e.clientY + 'px';
            menu.style.left = e.clientX + 'px';
            if (window.innerWidth <= 768) {
                menu.style.maxHeight = '60vh';
                menu.style.overflowY = 'auto';
            }
        }

        const settings = getSettings();
        const characterId = getCurrentCharacterId();

        let html = '<div class="tmc_ctx_head">' + (isBulk ? `Move ${selectedChats.size} chats to...` : 'Actions') + '</div>';

        if (!isBulk) {
            // Pin option
            const pinText = isPinnedFile(fileName) ? 'Unpin' : 'Pin to top';
            html += `<div class="tmc_ctx_item" data-action="pin">📌 ${pinText}</div>`;
            // Add Rename and Delete
            html += `<div class="tmc_ctx_item" data-action="rename">✏️ Rename</div>`;
            html += `<div class="tmc_ctx_item" data-action="movechar">👤 Move to card…</div>`;
            html += `<div class="tmc_ctx_item" data-action="delete" style="color:var(--red);">🗑️ Delete</div>`;
        }

        const folderList = buildFolderList(settings, characterId);
        const currentFid = (!isBulk && fileName) ? getFolderForChat(fileName) : 'uncategorized';
        html += buildMoveSectionHtml(folderList, currentFid, isBulk);

        menu.innerHTML = html;
        document.body.appendChild(menu);
        if (!isBulk) clampMenuToViewport(menu);

        menu.onclick = (ev) => {
            const item = ev.target.closest('.tmc_ctx_item');
            if (!item) return;

            // Where did the chat(s) land — say so. Silent success reads as
            // a broken button (v0.12.1).
            const folderLabel = (fid) => fid === 'uncategorized'
                ? 'Your chats'
                : ('📁 ' + (getSettings().folders[fid]?.name || '?'));
            const familyHint = getSettings().familyView && !cardsMode
                ? ' — visible when Families is off' : '';

            if (item.dataset.action === 'newfolder-move') {
                const n = prompt('New folder name:');
                const newFid = n ? createFolder(n) : null;
                if (newFid) {
                    const files = isBulk ? Array.from(selectedChats) : [fileName];
                    moveChats(files, newFid);
                    if (isBulk) clearSelection();
                    toastr.success(`Moved ${files.length} chat${files.length !== 1 ? 's' : ''} to ${folderLabel(newFid)}${familyHint}`);
                }
                cleanup();
                scheduleSync();
                return;
            }

            if (isBulk) {
                const targetFid = item.dataset.fid;
                moveChats(Array.from(selectedChats), targetFid);
                toastr.success(targetFid === 'uncategorized'
                    ? `Removed ${selectedChats.size} chat${selectedChats.size !== 1 ? 's' : ''} from folders`
                    : `Moved ${selectedChats.size} chat${selectedChats.size !== 1 ? 's' : ''} to ${folderLabel(targetFid)}${familyHint}`);
                clearSelection();
            } else {
                if (item.dataset.action === 'pin') {
                    togglePin(fileName);
                } else if (item.dataset.action === 'movechar') {
                    cleanup();
                    showCharacterPicker(ev, [fileName]);
                    return;
                } else if (item.dataset.action === 'rename') {
                    // Trigger rename on original element
                    const originalBlock = findNativeBlock(fileName);
                    const renameBtn = originalBlock?.querySelector('.renameChatButton') || originalBlock?.querySelector('.fa-pen');
                    if (renameBtn) renameBtn.click();
                } else if (item.dataset.action === 'delete') {
                    // Trigger delete on original element
                    const originalBlock = findNativeBlock(fileName);
                    // Look for typical delete class names
                    const delBtn = originalBlock?.querySelector('.mes_delete') ||
                        originalBlock?.querySelector('.fa-skull') ||
                        originalBlock?.querySelector('[class*="delete"]');
                    if (delBtn) delBtn.click();
                    else console.warn('TMC: Could not find delete button for', fileName);
                } else if (item.dataset.fid) {
                    const targetFid = item.dataset.fid;
                    const beforeFid = getFolderForChat(fileName);
                    if (beforeFid === targetFid) {
                        toastr.info(`Already in ${folderLabel(targetFid)}`);
                    } else {
                        moveChat(fileName, targetFid);
                        toastr.success(targetFid === 'uncategorized'
                            ? `Removed from ${folderLabel(beforeFid)}`
                            : `Moved to ${folderLabel(targetFid)}${familyHint}`);
                    }
                }
            }
            // v0.13.0: cleanup(), not bare remove() — otherwise the document
            // click/Escape listeners from this menu linger until the next
            // unrelated click.
            cleanup();
        };

        // Close on click outside
        const closeHandler = (ev) => {
            if (!menu.contains(ev.target)) {
                cleanup();
            }
        };

        // Close on Escape
        const escHandler = (ev) => {
            if (ev.key === 'Escape') cleanup();
        };

        function cleanup() {
            menu.remove();
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('keydown', escHandler);
        }

        setTimeout(() => {
            document.addEventListener('click', closeHandler);
            document.addEventListener('keydown', escHandler);
        }, 50);

        // Also close if another menu is opened (handled by top of showContextMenu)
        // But we should ensure listeners are cleaned up if removed externally
        // MutationObserver on body could detect removal, but let's just be careful.
        // For now, simpler is better. logic at start of function removes .tmc_ctx,
        // but that won't remove the *listeners* attached to document for those old menus.
        // FIX: Add a custom property to the menu element to call cleanup
        menu.cleanup = cleanup;
    }

    // ========== OBSERVER ==========

    function initObserver() {
        if (mutationObserver) mutationObserver.disconnect();

        mutationObserver = new MutationObserver(handleMutations);

        // v0.8.1 PERF ROOT FIX: this used to observe document.body with
        // subtree+attributes. The v0.7.0 observer split (correctly) brought
        // this observer back to life — and with it, EVERY DOM mutation in the
        // app started flowing through our callback: thousands of message
        // nodes while a big chat loads, style churn on every streamed token
        // during generation. Each mutation paid an m.target.closest() DOM
        // walk. We only ever care about the chat-select popup, so observe
        // exactly those nodes. During RP and chat loads our callback now
        // sees zero traffic.
        observedPopupNodes = getPopupNodes();
        if (observedPopupNodes.length > 0) {
            for (const node of observedPopupNodes) {
                mutationObserver.observe(node, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class']
                });
            }
        } else {
            // Unknown ST build without the standard popup ids: fall back to
            // the old broad observation rather than silently doing nothing.
            console.warn('[TMC] Chat popup nodes not found; falling back to body-wide observation');
            mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'id']
            });
        }
    }

    function getPopupNodes() {
        return ['#shadow_select_chat_popup', '#select_chat_popup']
            .map(sel => document.querySelector(sel))
            .filter(Boolean);
    }

    // Single source of truth for "is the panel open", driven by the popup's
    // own style mutations (any open path: menu click, slash command, etc.).
    // v0.8.1: userOpenedPanel previously latched true FOREVER after the first
    // open — heartbeat and sync kept doing per-tick work for the rest of the
    // session. It now tracks real visibility; closing the popup also tears
    // down bulk-selection state so the floating bulk bar can't outlive it.
    function syncPanelVisibility() {
        const visible = getPopupNodes().some(n => getComputedStyle(n).display !== 'none');
        if (visible && !userOpenedPanel) {
            userOpenedPanel = true;
            activeScrolledThisOpen = false;
            scheduleSync();
        } else if (!visible && userOpenedPanel) {
            userOpenedPanel = false;
            cardsMode = false;
            renderedCounts = {};
            if (bulkMode || selectedChats.size > 0) clearSelection();
        }
    }

    function handleMutations(mutations) {
            let needsSync = false;
            let popupToggled = false;
            for (const m of mutations) {
                // IGNORE our own proxy elements
                if (m.target.closest && m.target.closest('#tmc_proxy_root')) continue;
                if (m.target.classList && m.target.classList.contains('tmc_proxy_block')) continue;

                // Detect native chat blocks being added (async load)
                if (m.target.id === 'select_chat_div' || m.target.classList?.contains('select_chat_block_wrapper')) {
                    needsSync = true;
                    continue;
                }
                // Detect popup visibility changes
                if (m.target.id === 'shadow_select_chat_popup' || m.target.id === 'select_chat_popup') {
                    popupToggled = true;
                    needsSync = true;
                    continue;
                }
                // Detect new blocks added anywhere in popup
                if (m.addedNodes?.length > 0) {
                    for (const node of m.addedNodes) {
                        if (node.classList?.contains('select_chat_block')) {
                            needsSync = true;
                            break;
                        }
                    }
                }

                // Detect native search finishing its own filtering pass.
                // ST hides non-matching chat blocks by toggling their inline
                // `style.display`, asynchronously and on its own timing (not
                // necessarily in sync with our 200ms debounce off the input
                // event). Previously we only resynced off the `input` event,
                // so if ST's filter pass hadn't finished setting display:none
                // yet by the time we read it, we'd render stale (unfiltered)
                // results, and nothing would trigger a follow-up sync until
                // another keystroke happened to land after ST finished -
                // which is exactly the "type a trailing space to fix it" bug.
                // Watching for the style mutation itself removes the race
                // entirely, regardless of how long ST's filtering takes.
                if (m.type === 'attributes' && m.attributeName === 'style' &&
                    m.target.classList?.contains('select_chat_block') &&
                    !m.target.classList.contains('tmc_proxy_block')) {
                    needsSync = true;
                }
            }
            if (popupToggled) syncPanelVisibility();
            if (needsSync && userOpenedPanel) scheduleSync();
    }

    // ========== INIT ==========

    function init() {
        console.log(`[${EXTENSION_NAME}] v0.16.0 Loading...`);
        const ctx = SillyTavern.getContext();

        // v0.11.0 one-time migration: normalize + dedupe stored folder chat
        // ids (older TMC/ST combos stored them with .jsonl; current blocks
        // report without it, silently orphaning every assignment).
        try {
            const s = getSettings();
            let changed = false;
            for (const fid of Object.keys(s.folders || {})) {
                const f = s.folders[fid];
                if (!f || !Array.isArray(f.chats)) continue;
                const norm = [...new Set(f.chats.map(normalizeChatId))];
                if (norm.length !== f.chats.length || norm.some((v, i) => v !== f.chats[i])) {
                    f.chats = norm;
                    changed = true;
                }
            }
            if (changed) saveSettings();
        } catch (e) {
            console.warn('[TMC] Folder id migration skipped:', e);
        }

        // v0.8.0: restore persisted sort choice (falls back to activity-desc
        // via defaultSettings backfill in getSettings).
        try {
            const persisted = getSettings().sortOrder;
            if (typeof persisted === 'string' && persisted) sortOrder = persisted;
        } catch (e) {
            console.warn('[TMC] Could not restore sort order:', e);
        }

        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            // The open chat just changed — allow the next render to scroll to it.
            activeScrolledThisOpen = false;
            // v0.9.0: opening a chat IS activity. This is precisely what puts
            // a just-created branch at the top instantly (ST switches into the
            // branch on creation), and lets pre-existing branches self-heal
            // the first time they're opened.
            stampActivity();
            // Branch metadata may be stale (a branch might just have been
            // created); invalidate so the next popup-visible sync refetches.
            activityData.fetchedAt = 0;
            scheduleSync();
        });

        // v0.9.0: message-level interaction also counts as activity. Event
        // names vary slightly across ST builds — subscribe only to the ones
        // this build exposes.
        for (const evName of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
            if (ctx.event_types[evName]) {
                ctx.eventSource.on(ctx.event_types[evName], () => {
                    stampActivity();
                    // v0.15.0: a turn just changed the open chat's last
                    // message — cached beginnings / search content are stale.
                    invalidateChatContentCaches();
                });
            }
        }

        // v0.13.0: ST emits CHAT_RENAMED from EVERY rename path (chat-block
        // pencil, welcome screen, slash command) with
        // { avatarId, groupId, oldFileName, newFileName } (.jsonl included).
        // Renames used to orphan every piece of TMC bookkeeping keyed by
        // the old name — folder membership, pin, activity stamp, family
        // collapse state. Migrate it all to the new name. Feature-detected
        // like the message events, so older builds without the event simply
        // keep the pre-0.13.0 behavior.
        if (ctx.event_types.CHAT_RENAMED) {
            ctx.eventSource.on(ctx.event_types.CHAT_RENAMED, (data) => {
                try {
                    const charKey = (data && data.groupId)
                        ? String(data.groupId)
                        : ((data && data.avatarId) ? String(data.avatarId) : getCurrentCharacterId());
                    const oldId = normalizeChatId(data && data.oldFileName);
                    const newId = normalizeChatId(data && data.newFileName);
                    if (!charKey || !oldId || !newId || oldId === newId) return;
                    const settings = getSettings();
                    if (migrateChatRename(settings, charKey, oldId, newId)) saveSettings();
                    // In-memory state keyed by the old spelling(s):
                    for (const spelling of [oldId, oldId + '.jsonl']) {
                        delete nativeDataCache[spelling];
                        if (selectedChats.has(spelling)) {
                            selectedChats.delete(spelling);
                            selectedChats.add(newId);
                        }
                    }
                    if (activityData.branchOf && activityData.branchOf[oldId]) {
                        activityData.branchOf[newId] = activityData.branchOf[oldId];
                        delete activityData.branchOf[oldId];
                    }
                    // Children's chat_metadata.main_chat may reference the
                    // old name — force a refetch so chips reflect reality.
                    activityData.fetchedAt = 0;
                    scheduleSync();
                } catch (err) {
                    console.warn('[TMC] Rename migration failed:', err);
                }
            });
        }

        // v0.14.0: chats also disappear WITHOUT going through TMC — the native
        // skull, /delchat, another extension. stripDeletedFromFolders is the
        // one canonical cleanup for a chat leaving a card (folder membership,
        // pin, activity stamp); until now it only ran on TMC's own bulk delete
        // and move-to-card, so every other delete left orphaned bookkeeping
        // behind. Worse than untidy: a folder still holding a dead name will
        // silently swallow a future chat that happens to be renamed onto it.
        // Both events carry the chat name (no extension); normalized anyway.
        for (const evName of ['CHAT_DELETED', 'GROUP_CHAT_DELETED']) {
            if (!ctx.event_types[evName]) continue;
            ctx.eventSource.on(ctx.event_types[evName], (name) => {
                try {
                    const charKey = getCurrentCharacterId();
                    const id = normalizeChatId(typeof name === 'string' ? name : (name && name.file_name));
                    if (!charKey || !id) return;
                    const settings = getSettings();
                    if (stripDeletedFromFolders(settings, charKey, [id])) saveSettings();
                    delete nativeDataCache[id];
                    delete nativeDataCache[id + '.jsonl'];
                    selectedChats.delete(id);
                    selectedChats.delete(id + '.jsonl');
                    activityData.fetchedAt = 0; // parentage may have changed
                    scheduleSync();
                } catch (err) {
                    console.warn('[TMC] Post-delete cleanup failed:', err);
                }
            });
        }

        // Listen for user opening chat history popup
        document.addEventListener('click', (e) => {
            const manageBtn = e.target.closest('#option_select_chat, [onclick*="select_chat"], .mes_button[title*="Chat"], [data-i18n="Manage"]');
            if (manageBtn) {
                userOpenedPanel = true;
                activeScrolledThisOpen = false;
                // Force a resync as soon as the panel is opened, rather than relying
                // solely on the mutation observer / heartbeat to notice.
                scheduleSync();
            }
        }, true);

        // Heartbeat: check for empty folders or missing proxy root
        setInterval(() => {
            // v0.8.1: safety nets that must run even while the panel is closed —
            // (a) if the popup nodes didn't exist at init (exotic ST build /
            //     load order), attach the narrow observer as soon as they do;
            // (b) reconcile visibility state in case a style mutation was
            //     missed (also flips userOpenedPanel back off after close,
            //     which stops all per-tick work below).
            if (observedPopupNodes.length === 0 && getPopupNodes().length > 0) initObserver();
            syncPanelVisibility();

            if (!userOpenedPanel) return;

            const popup = document.querySelector('#shadow_select_chat_popup') || document.querySelector('#select_chat_popup');
            if (popup && getComputedStyle(popup).display !== 'none') {
                const proxy = popup.querySelector('#tmc_proxy_root');
                const nativeBlocks = popup.querySelectorAll('.select_chat_block:not(.tmc_proxy_block)');
                const proxyBlocks = popup.querySelectorAll('.tmc_proxy_block');
                const activeCharacterId = getCurrentCharacterId();

                // Re-sync if: no proxy root, or native blocks exist but no proxy blocks,
                // or (critically) the active character has changed since the proxy tree
                // was last built. That last case covers switching characters while the
                // popup is closed, or while it's open but reused/cached by SillyTavern
                // without emitting a mutation our observer catches — without this check
                // the proxy tree can keep showing the previous character's chats until
                // some unrelated action (sort/bulk) happens to force a resync.
                if (!proxy || proxy.children.length === 0 ||
                    (nativeBlocks.length > 0 && proxyBlocks.length === 0) ||
                    (activeCharacterId && activeCharacterId !== lastSyncedCharacterId)) {
                    scheduleSync();
                }
            }
        }, 500);

        initObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
