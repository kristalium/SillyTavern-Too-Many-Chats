import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const src = readFileSync('./index.js', 'utf8');
let pass = 0, fail = 0;
const assert = (cond, name) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)); };

// --- extract a top-level function body from the real source by brace counting ---
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error('not found: ' + name);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}

// --- DOM + ST stubs ---
const dom = new JSDOM('<!doctype html><body></body>');
globalThis.document = dom.window.document;

const fnSource = ['escapeHtml', 'highlightText', 'getActiveChatName', 'isActiveChatFile'].map(extract).join('\n');
const api = new Function('SillyTavern', 'document', fnSource +
    '\nreturn { escapeHtml, highlightText, getActiveChatName, isActiveChatFile };');

console.log('[1] XSS fix: real DOM round-trip proof');
{
    const { escapeHtml, highlightText } = api({ getContext: () => ({}) }, document);
    const evil = '<img src=x onerror=alert(1)> chat about stuff';
    const probe = document.createElement('div');

    // NEW code path: escape first, then highlight
    probe.innerHTML = highlightText(escapeHtml(evil), 'chat');
    assert(probe.querySelector('img') === null, 'fixed path: no <img> element ever created');
    assert(probe.textContent.includes('<img src=x onerror=alert(1)>'), 'fixed path: tag visible as literal text');
    assert(probe.querySelectorAll('span').length === 1, 'fixed path: highlight span still applied');

    // OLD code path (pre-fix): raw title straight into highlightText
    probe.innerHTML = highlightText(evil, 'chat');
    assert(probe.querySelector('img') !== null, 'sanity: old path really did create an <img> element (exploitable)');
}

console.log('[2] isActiveChatFile: solo chat via context.chatId');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 'My Epic Chat' }) }, document);
    assert(isActiveChatFile('My Epic Chat.jsonl') === true, 'matches with .jsonl extension');
    assert(isActiveChatFile('My Epic Chat') === true, 'matches without extension');
    assert(isActiveChatFile('My Epic Chat 2.jsonl') === false, 'no prefix false-positive');
    assert(isActiveChatFile('') === false, 'empty fileName is false');
}

console.log('[3] isActiveChatFile: fallback to character card .chat field');
{
    const ctx = { chatId: undefined, characterId: 0, characters: [{ chat: 'Branch #2 - Old Story' }] };
    const { isActiveChatFile } = api({ getContext: () => ctx }, document);
    assert(isActiveChatFile('Branch #2 - Old Story.jsonl') === true, 'fallback path matches');
    assert(isActiveChatFile('Old Story.jsonl') === false, 'fallback path rejects parent chat');
}

console.log('[4] isActiveChatFile: numeric group chat_id survives String() coercion');
{
    const { isActiveChatFile } = api({ getContext: () => ({ chatId: 1720000000000 }) }, document);
    assert(isActiveChatFile('1720000000000.jsonl') === true, 'numeric group id matches file');
}

console.log('[5] isActiveChatFile: no context -> never throws, never matches');
{
    const { isActiveChatFile } = api({ getContext: () => { throw new Error('boom'); } }, document);
    assert(isActiveChatFile('Anything.jsonl') === false, 'throwing context handled');
}

console.log('[6] Observer split: static structure of the real file');
{
    const iio = extract('initIntersectionObserver');
    const io = extract('initObserver');
    assert(iio.includes('lazyObserver.disconnect') && !iio.includes('mutationObserver'), 'initIntersectionObserver touches ONLY lazyObserver');
    assert(io.includes('mutationObserver.disconnect') && !io.includes('lazyObserver'), 'initObserver touches ONLY mutationObserver');
    const noComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!/\blet observer\b|[^a-zA-Z.]observer\.(observe|disconnect|unobserve)/.test(noComments), 'no bare shared observer usage remains (comments excluded)');
    const rb = extract('renderBatch');
    assert(rb.includes('lazyObserver.observe(sentinel)'), 'sentinels observed by lazyObserver');
}

console.log('[7] Reset wiring for scroll-once flag');
{
    const resets = (src.match(/[^t] activeScrolledThisOpen = false/g) || []).length; // excludes 'let activeScrolledThisOpen'
    assert(resets === 5, `flag reset in exactly 5 places, got ${resets}: CHAT_CHANGED, panel open click, char switch, failed-scroll release, popup-visible transition`);
    assert(extract('createFolderDOM').includes('tmc_has_active'), 'folder dot wired');
}


console.log('[8] buildActivityData: branch parentage extraction + character filtering');
{
    const build = new Function(extract('buildActivityData') + '\nreturn buildActivityData;')();
    const items = [
        { file_id: 'Branch #1 - Old', avatar: 'A.png', chat_metadata: { main_chat: 'Old' } },
        { file_id: 'Fresh', avatar: 'A.png' },
        { file_id: 'OtherBranch', avatar: 'B.png', chat_metadata: { main_chat: 'Elsewhere' } },
        { file_id: 'GB', group: 1720000000, chat_metadata: { main_chat: 'GroupParent' } },
        { file_id: 'Old', avatar: 'A.png', chat_metadata: {} },
        { file_id: 'RootStray', chat_metadata: { main_chat: 'X' } },
        null,
        { file_id: 42, avatar: 'A.png' },
    ];
    const a = build(items, 'A.png');
    assert(JSON.stringify(a.branchOf) === JSON.stringify({ 'Branch #1 - Old': 'Old' }),
        'only current character branches captured: ' + JSON.stringify(a.branchOf));
    assert(!('rank' in a), 'rank machinery gone from builder');
    const g = build(items, 1720000000);
    assert(g.branchOf['GB'] === 'GroupParent', 'numeric group id matches via String coercion');
    assert(JSON.stringify(build(undefined, 'A.png')) === JSON.stringify({ branchOf: {} }), 'non-array input safe');
}

console.log('[9] sortChats: precomputed activity field — THE branch scenario');
{
    const mkSort = new Function('sortOrder', extract('sortChats') + '\nreturn sortChats;');
    const mk = (name, date, activity) => ({ fileName: name + '.jsonl', activity, metadata: { name: name.toLowerCase(), date, msgCount: 0, size: 0 } });
    const chats = [
        mk('Ancient', 100, 100),
        mk('Fresh', 3000, 3000),
        mk('Branch #1 - Old', 990, 5000), // stamped: opened just now
        mk('Old', 1000, 1000),
    ];
    let out = mkSort('activity-desc')([...chats]).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Branch #1 - Old.jsonl', 'Fresh.jsonl', 'Old.jsonl', 'Ancient.jsonl']),
        'stamped branch with OLD last-msg date sorts FIRST: ' + JSON.stringify(out));
    // unstamped library: activity collapses to last-msg time -> branch sinks (pre-fix behavior)
    const cold = chats.map(c => ({ ...c, activity: c.metadata.date }));
    out = mkSort('activity-desc')(cold).map(c => c.fileName);
    assert(JSON.stringify(out) === JSON.stringify(['Fresh.jsonl', 'Old.jsonl', 'Branch #1 - Old.jsonl', 'Ancient.jsonl']),
        'unstamped library degrades to last-message desc');
    // floor semantics
    const floor = chats.map(c => ({ ...c, activity: c.fileName.startsWith('Old') ? 2000 : c.metadata.date }));
    out = mkSort('activity-desc')(floor).map(c => c.fileName);
    assert(out[0] === 'Fresh.jsonl' && out[1] === 'Old.jsonl', 'stamp is a floor, not a tier');
    out = mkSort('name-asc')([...chats]).map(c => c.fileName);
    assert(out[0] === 'Ancient.jsonl', 'regression: name-asc unaffected');
}

console.log('[10] getBranchParent: extension stripping and miss behavior');
{
    const getBP = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;')(
        { charKey: 'A.png', fetchedAt: 0, rank: {}, branchOf: { 'X': 'Parent Chat' } });
    assert(getBP('X.jsonl') === 'Parent Chat', 'strips .jsonl before lookup');
    assert(getBP('X') === 'Parent Chat', 'bare name works');
    assert(getBP('Y.jsonl') === null, 'miss returns null');
    assert(getBP(null) === null, 'null-safe');
}

console.log('[11] v0.8.0 wiring: static structure of the real file');
{
    const rad = extract('refreshActivityData');
    const radCode = rad.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!radCode.includes('pinned'), 'refresh omits pinned param in code (would corrupt mtime rank)');
    assert(rad.includes('metadata: true') && rad.includes('/api/chats/recent'), 'requests /recent with metadata:true');
    assert(extract('performSync').includes('refreshActivityData()'), 'performSync kicks TTL-gated refresh');
    const srcNoComments = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert(!srcNoComments.includes('refreshActivityData(true)'), 'no force-refresh remains in code (v0.8.1: was firing full-library scan per chat open)');
    assert(src.includes('"activity-desc">Active (Recent)') || src.includes("value=\"activity-desc\">Active (Recent)"), 'dropdown has Active option');
    assert(src.includes("sortOrder: 'activity-desc'"), 'defaultSettings carries persisted default');
    assert(src.includes('getSettings().sortOrder = sortOrder'), 'onchange persists selection');
    assert(extract('createProxyBlock').includes('getBranchParent'), 'branch chip wired into proxy block');
}


const stripComments = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

console.log('[12] v0.8.1 perf wiring: fetch gated behind visible popup, observer scoped');
{
    const ps = stripComments(extract('performSync'));
    const gateIdx = ps.indexOf('if (!popup) return;');
    const fetchIdx = ps.indexOf('refreshActivityData()');
    assert(gateIdx > -1 && fetchIdx > gateIdx, 'refreshActivityData sits AFTER the popup-visible gate');
    const initFn = stripComments(extract('init'));
    assert(initFn.includes('activityData.fetchedAt = 0'), 'CHAT_CHANGED invalidates activity cache');
    assert(!initFn.includes('refreshActivityData'), 'CHAT_CHANGED never fetches directly');
    const io = stripComments(extract('initObserver'));
    assert(io.includes('getPopupNodes()') && io.includes('mutationObserver.observe(node'), 'observer attaches to popup nodes');
    assert(io.includes('document.body'), 'body observation kept only as fallback branch');
    assert(initFn.includes('syncPanelVisibility()') && initFn.includes('if (!userOpenedPanel) return;'), 'heartbeat reconciles visibility then early-outs when closed');
}

console.log('[13] syncPanelVisibility: open/close transitions and bulk-bar teardown');
{
    const mk = new Function('getPopupNodes', 'getComputedStyle', 'scheduleSync', 'clearSelection', 'state',
        'let userOpenedPanel = state.open; let activeScrolledThisOpen = true; let bulkMode = state.bulk; let selectedChats = state.sel; let cardsMode = true; let renderedCounts = {};\n'
        + extract('syncPanelVisibility')
        + '\nreturn { run: syncPanelVisibility, state: () => ({ userOpenedPanel, activeScrolledThisOpen }) };');
    let synced = 0, cleared = 0;
    // hidden -> visible
    let h = mk(() => [{}], () => ({ display: 'flex' }), () => synced++, () => cleared++, { open: false, bulk: false, sel: new Set() });
    h.run();
    assert(h.state().userOpenedPanel === true && h.state().activeScrolledThisOpen === false && synced === 1, 'open transition: flag on, scroll reset, sync scheduled');
    // visible -> hidden with live bulk selection
    h = mk(() => [{}], () => ({ display: 'none' }), () => synced++, () => cleared++, { open: true, bulk: true, sel: new Set(['a']) });
    h.run();
    assert(h.state().userOpenedPanel === false && cleared === 1, 'close transition: flag off, bulk selection torn down');
}

console.log('[14] Content cache LRU: cap, eviction order, touch-refresh');
{
    const capMatch = src.match(/const CONTENT_CACHE_MAX = (\d+);/);
    assert(!!capMatch, 'cap constant present');
    const cap = parseInt(capMatch[1], 10);
    const mk = new Function('CONTENT_CACHE_MAX',
        'let chatContentCache = {}; let contentCacheOrder = [];\n'
        + extract('touchContentCache')
        + '\nreturn { touch: touchContentCache, set: (k) => { chatContentCache[k] = [k]; touchContentCache(k); }, cache: () => chatContentCache, order: () => contentCacheOrder };');
    const c = mk(cap);
    for (let i = 0; i < cap + 6; i++) c.set('A.png::chat' + i);
    assert(Object.keys(c.cache()).length === cap, `cache bounded at ${cap} after ${cap + 6} inserts`);
    assert(!c.cache()['A.png::chat0'] && !!c.cache()['A.png::chat' + (cap + 5)], 'oldest evicted, newest kept');
    // touch-refresh: oldest surviving key touched, then one more insert evicts the SECOND-oldest instead
    const survivors = c.order().slice();
    c.touch(survivors[0]);
    c.set('A.png::fresh');
    assert(!!c.cache()[survivors[0]] && !c.cache()[survivors[1]], 'touched entry survives; untouched next-oldest evicted');
}

console.log('[15] Pin scoping: per-character isolation with legacy migration');
{
    const shared = { pinned: { 'New Chat.jsonl': true } }; // legacy global pin
    let charKey = 'A.png';
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'saveSettings', 'scheduleSync',
        extract('normalizeChatId') + '\n' + extract('pinKey') + '\n' + extract('isPinnedFile') + '\n' + extract('togglePin')
        + '\nreturn { pinKey, isPinnedFile, togglePin };');
    const api15 = mk(() => shared, () => charKey, () => {}, () => {});
    assert(api15.isPinnedFile('New Chat.jsonl') === true, 'legacy bare-key pin honored on read');
    api15.togglePin('New Chat.jsonl'); // unpin: migrates legacy away
    assert(!shared.pinned['New Chat.jsonl'] && !shared.pinned['A.png::New Chat'] && !shared.pinned['New Chat'], 'toggle migrates legacy key away');
    api15.togglePin('New Chat.jsonl'); // pin again -> scoped
    assert(shared.pinned['A.png::New Chat'] === true, 'repin writes normalized character-scoped key');
    charKey = 'B.png';
    assert(api15.isPinnedFile('New Chat.jsonl') === false, 'same filename NOT pinned on another character');
}

console.log('[16] Group preview fetches THIS entry, not the open chat');
{
    const fcm = stripComments(extract('fetchChatMessages'));
    assert(/isGroup\s*\n?\s*\?\s*\{\s*id:\s*fileName\.replace/.test(fcm), 'group body id derived from fileName');
    assert(!/id:\s*context\.groupId/.test(fcm), 'old wrong-file body gone');
    assert(fcm.includes('contentCacheKey(fileName)'), 'cache reads/writes use character-scoped key');
}

console.log('[17] escAttr: selector-safe filenames');
{
    const esc = new Function(extract('escAttr') + '\nreturn escAttr;')();
    assert(esc('a"b\\c') === 'a\\"b\\\\c', 'quotes and backslashes escaped');
    assert(esc('plain name.jsonl') === 'plain name.jsonl', 'plain names untouched');
    assert(stripComments(extract('findNativeBlock')).includes('escAttr(fileName)'), 'native block lookup routed through escAttr');
}

console.log('[18] Bulk delete: group branch wired through ST group-chats module');
{
    const ub = stripComments(extract('updateBulkBar'));
    assert(ub.includes("import('/scripts/group-chats.js')") && ub.includes('deleteGroupChatByName(groupId'), 'group path uses deleteGroupChatByName');
    assert(ub.includes('!groupId && (characterId === undefined'), 'character-missing error only fires OUTSIDE groups');
}

console.log('[19] refreshActivityData: stale branch map dropped on switch; small fetch window');
{
    let fetchCalls = 0; let lastBody = null;
    const pendingFetch = (url, opts) => { fetchCalls++; lastBody = opts.body; return new Promise(() => {}); };
    const ttl = parseInt(src.match(/const ACTIVITY_TTL_MS = (\d+);/)[1], 10);
    const bmax = parseInt(src.match(/const BRANCH_FETCH_MAX = (\d+);/)[1], 10);
    assert(bmax <= 100, `branch fetch window small (${bmax}) — endpoint only line-streams top-N, so cost stays bounded`);
    const mk = new Function('getCurrentCharacterId', 'buildActivityData', 'scheduleSync', 'fetch', 'SillyTavern', 'ACTIVITY_TTL_MS', 'BRANCH_FETCH_MAX', 'initial', 'console',
        'let activityData = initial;\n' + 'async ' + extract('refreshActivityData')
        + '\nreturn { run: refreshActivityData, get: () => activityData };');
    const a = mk(() => 'B.png', () => ({ branchOf: {} }), () => {}, pendingFetch,
        { getContext: () => ({ getRequestHeaders: () => ({}) }) }, ttl, bmax,
        { charKey: 'A.png', fetchedAt: Date.now(), branchOf: { 'Old': 'P' } }, console);
    a.run(); // char switched A -> B; fetch left pending on purpose
    assert(a.get().charKey === 'B.png' && Object.keys(a.get().branchOf).length === 0, 'previous character branch map dropped before fetch resolves');
    assert(fetchCalls === 1 && JSON.parse(lastBody).max === bmax && JSON.parse(lastBody).metadata === true, 'one fetch, bounded max, metadata on');
    a.run(); // same char, within TTL, not forced
    assert(fetchCalls === 1, 'TTL gate suppresses duplicate fetch');
}

console.log('[20] Search render fan-out capped');
{
    assert(/searchTerm\s*\n?\s*\?\s*Math\.min\(/.test(extract('performSync')), 'initial search render capped via Math.min (sentinel lazy-loads rest)');
}


console.log('[21] Activity stamping: write, scope, prune');
{
    const shared2 = { lastActive: {} };
    let saves = 0; let charKey2 = 'A.png'; let activeChat = 'My Branch';
    const capHard = parseInt(src.match(/const LAST_ACTIVE_HARD_CAP = (\d+);/)[1], 10);
    const capKeep = parseInt(src.match(/const LAST_ACTIVE_KEEP = (\d+);/)[1], 10);
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'getActiveChatName', 'saveSettings', 'LAST_ACTIVE_HARD_CAP', 'LAST_ACTIVE_KEEP',
        extract('lastActiveKey') + '\n' + extract('stampActivity') + '\n' + extract('getLastActive') + '\n' + extract('pruneLastActive')
        + '\nreturn { stamp: stampActivity, get: getLastActive, prune: pruneLastActive };');
    const api21 = mk(() => shared2, () => charKey2, () => activeChat, () => saves++, capHard, capKeep);
    api21.stamp();
    assert(api21.get('My Branch.jsonl') > 0 && saves === 1, 'stamp written under scoped key, settings saved');
    charKey2 = 'B.png';
    assert(api21.get('My Branch.jsonl') === 0, 'stamp invisible from another character');
    charKey2 = 'A.png'; activeChat = null;
    api21.stamp();
    assert(saves === 1, 'no active chat -> no write, no save');
    // prune: overfill past hard cap, oldest dropped, newest kept
    const m = {};
    for (let i = 1; i <= capHard + 1; i++) m['A.png::c' + i] = i;
    api21.prune(m);
    assert(Object.keys(m).length === capKeep, `pruned to ${capKeep}`);
    assert(!m['A.png::c1'] && !!m['A.png::c' + (capHard + 1)], 'oldest evicted, newest kept');
}

console.log('[22] getBranchParent: metadata first, filename-pattern fallback');
{
    const mk = new Function('activityData', extract('getBranchParent') + '\nreturn getBranchParent;');
    const getBP = mk({ branchOf: { 'Meta Chat': 'Real Parent', 'Named - Branch #9': 'Metadata Wins' } });
    assert(getBP('Meta Chat.jsonl') === 'Real Parent', 'metadata hit');
    assert(getBP('Named - Branch #9.jsonl') === 'Metadata Wins', 'metadata takes precedence over pattern');
    assert(getBP('Epic Story - Branch #3.jsonl') === 'Epic Story', 'modern naming fallback');
    assert(getBP('Branch #2 - Old Tale') === 'Old Tale', 'legacy naming fallback');
    assert(getBP('Just A Chat.jsonl') === null, 'plain chats untouched');
}


console.log('[23] resolveFamilyRoot: transitive climb, cycle guard, extension handling');
{
    const chains = { 'C': 'B', 'B': 'A' };
    const mk = new Function('getBranchParent', extract('resolveFamilyRoot') + '\nreturn resolveFamilyRoot;');
    const resolve = mk((id) => chains[String(id).replace(/\.jsonl$/i, '')] || null);
    assert(resolve('C.jsonl') === 'A', 'branch-of-a-branch climbs to root (C -> B -> A)');
    assert(resolve('A') === 'A', 'root resolves to itself');
    const cyc = mk((id) => ({ 'A': 'B', 'B': 'A' }[id] || null));
    const r = cyc('A');
    assert(r === 'A' || r === 'B', 'parentage cycle terminates deterministically without throwing');
}

console.log('[24] familyClusters: lineage sections, orphan branches, singles');
{
    const clusters = new Function(extract('familyClusters') + '\nreturn familyClusters;')();
    const resolver = (id) => {
        const m = id.match(/^(.*) - Branch #\d+$/) || id.match(/^Branch #\d+ - (.*)$/);
        return m ? m[1] : id;
    };
    const out = clusters(['Branch #2 - Saga', 'Solo', 'Saga', 'Lost Tale - Branch #1'], resolver);
    assert(JSON.stringify(out.order) === JSON.stringify(['Saga', 'Lost Tale']),
        'family order follows first appearance (= most recently active member): ' + JSON.stringify(out.order));
    assert(JSON.stringify(out.members['Saga']) === JSON.stringify(['Branch #2 - Saga', 'Saga']),
        'parent and branches share one section, input order preserved');
    assert(JSON.stringify(out.members['Lost Tale']) === JSON.stringify(['Lost Tale - Branch #1']),
        'orphan branch (parent deleted) still forms a family under the lineage name');
    assert(JSON.stringify(out.singles) === JSON.stringify(['Solo']), 'non-branch chats without branches stay single');
    assert(JSON.stringify(clusters([], resolver)) === JSON.stringify({ order: [], members: {}, singles: [] }), 'empty input safe');
}

console.log('[25] Family view wiring: static structure of the real file');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('familyClusters(') && ps.includes("'family::' + root"), 'performSync builds family sections from sorted order');
    assert(ps.includes("createUncategorizedDOM('Other chats')"), 'non-family chats routed to Other chats in family mode');
    assert(ps.includes('familyFidByChat[chatId]'), 'distribution loop routes through the family map');
    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes("!isFamily") && rb.includes("|| isFamily)"), 'families exempt from 3-item truncation, included in sentinel lazy-load');
    assert(rb.includes('escAttr(folderId)'), 'section lookup selector escaped (family ids contain arbitrary chat names)');
    const ib = stripComments(extract('injectAddButton'));
    assert(ib.includes('s.familyView = !s.familyView') && ib.includes('saveSettings()'), 'toggle persists');
    assert(src.includes('familyView: false') && src.includes('familyCollapsed: {}'), 'settings schema carries family keys');
    assert(stripComments(extract('createFamilyDOM')).includes('familyCollapseKey(root)'), 'collapse state character-scoped');
}


console.log('[26] Chat id normalization: folders survive with/without .jsonl eras');
{
    const shared26 = { folders: { f1: { name: 'F', chats: ['Old Tale.jsonl'] } }, characterFolders: { 'A.png': ['f1'] } };
    const mk = new Function('getSettings', 'getCurrentCharacterId', 'saveSettings', 'scheduleSync',
        extract('normalizeChatId') + '\n' + extract('moveChat') + '\n' + extract('getFolderForChat')
        + '\nreturn { moveChat, getFolderForChat };');
    const api26 = mk(() => shared26, () => 'A.png', () => {}, () => {});
    assert(api26.getFolderForChat('Old Tale') === 'f1', 'legacy .jsonl-stored id matches current extensionless block');
    assert(api26.getFolderForChat('Old Tale.jsonl') === 'f1', 'and matches with extension too');
    api26.moveChat('New Story.jsonl', 'f1');
    assert(shared26.folders.f1.chats.includes('New Story') && !shared26.folders.f1.chats.includes('New Story.jsonl'),
        'moveChat stores normalized ids');
    api26.moveChat('Old Tale', 'uncategorized');
    assert(!shared26.folders.f1.chats.some(c => c.includes('Old Tale')), 'move-out strips legacy variant as well');
    const initSrc = stripComments(extract('init'));
    assert(initSrc.includes('normalizeChatId') && initSrc.includes('new Set'), 'one-time init migration normalizes + dedupes stored folder ids');
}

console.log('[27] Comparator perf: activity precomputed once per item per sync');
{
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('const laMap = getSettings().lastActive || {};'), 'stamp map snapshotted once per sync');
    assert((ps.match(/laPrefix \+ fileName\.replace/g) || []).length === 2, 'activity computed on both cache-hit and fresh paths');
    const sc = stripComments(extract('sortChats'));
    assert(sc.includes('a.activity') && !sc.includes('getLastActive('), 'comparator reads precomputed field, never calls getSettings');
}

console.log('[28] Click-time native re-resolution');
{
    const cpb = stripComments(extract('createProxyBlock'));
    assert((cpb.match(/findNativeBlock\(chatData\.fileName\)/g) || []).length >= 2, 'both button-forward and load-chat re-resolve at click time');
    assert(cpb.includes('liveNative.querySelector'), 'forwarded buttons search the LIVE native block');
}

console.log('[29] Scroll + rendered-depth persistence across re-syncs');
{
    const rb = stripComments(extract('renderBatch'));
    assert(rb.includes('renderedCounts[folderId] = Math.max'), 'renderBatch records section depth');
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('lastScrollTop = body.scrollTop') && ps.includes('body.scrollTop = lastScrollTop'), 'scroll captured and restored around rebuild');
    assert(ps.includes('renderedCounts = {};') && ps.includes('lastSearchTermSeen'), 'depths reset when the search term changes');
    assert(ps.includes('Math.min(renderedCounts[fid] || 0, sectionLen)'), 'initial batch restores remembered depth (clamped)');
    assert(stripComments(extract('syncPanelVisibility')).includes('renderedCounts = {}'), 'depths reset on popup close');
}

console.log('[30] Enrichment size guard');
{
    const cpb = stripComments(extract('createProxyBlock'));
    assert(cpb.includes('ENRICH_MAX_BYTES') && /<= ENRICH_MAX_BYTES\)\s*{\s*enrichPreviewWithContext/.test(cpb),
        'content fetch skipped for oversized chats; native preview retained');
}

console.log('[31] Proxy delete click routes to delete, not chat-load');
{
    const cpb = extract('createProxyBlock');
    assert(cpb.includes('.PastChat_cross, .fa-skull') || (cpb.includes('.PastChat_cross') && cpb.includes('.fa-skull')),
        'click-gate lists the native delete button classes');
    assert(cpb.includes("'.PastChat_cross, .mes_delete, .fa-trash, .fa-skull"), 'forward mapping includes PastChat_cross');
}

console.log('[32] Title resolver + jump-to-open');
{
    const el = document.createElement('div');
    el.innerHTML = '<div><small class="select_chat_block_filename">My Chat</small></div><div class="select_chat_block_mes">preview</div>';
    const getTitle = new Function('el', extract('getTitleEl').replace(/^function getTitleEl\(el\)/, 'function getTitleEl(el)') + '\nreturn getTitleEl(el);');
    const t = getTitle(el);
    assert(t && t.textContent === 'My Chat', 'current ST title class resolved (highlighting/chips land in the title row again)');
    const ib = stripComments(extract('injectAddButton'));
    assert(ib.includes('tmc_jump_btn') && ib.includes('scrollIntoView'), 'jump-to-open button wired');
    assert(!src.includes('createRecentDOM'), 'dead createRecentDOM removed');
}


console.log('[33] pickFreeName: never overwrite on the target card');
{
    const pick = new Function(extract('pickFreeName') + '\nreturn pickFreeName;')();
    const taken = new Set(['Saga', 'Saga #2']);
    assert(pick('Fresh', taken) === 'Fresh', 'free name passes through');
    assert(pick('Saga', taken) === 'Saga #3', 'collision walks past existing suffixes');
}

console.log('[34] adaptChatForTarget: header + source-named AI messages only');
{
    const adapt = new Function(extract('adaptChatForTarget') + '\nreturn adaptChatForTarget;')();
    const input = [
        { user_name: 'LO', character_name: 'Seika', chat_metadata: { main_chat: 'X' } },
        { name: 'Seika', is_user: false, mes: 'hello' },
        { name: 'LO', is_user: true, mes: 'hi' },
        { name: 'Rival NPC', is_user: false, mes: 'hmph' },
    ];
    const out = adapt(input, 'Seika', 'Seika V2');
    assert(out[0].character_name === 'Seika V2' && out[0].chat_metadata.main_chat === 'X', 'header rewritten, metadata preserved');
    assert(out[1].name === 'Seika V2', 'source-named AI message renamed');
    assert(out[2].name === 'LO' && out[3].name === 'Rival NPC', 'user + other NPCs untouched');
    assert(input[0].character_name === 'Seika' && input[1].name === 'Seika', 'input array not mutated');
}

console.log('[35] buildCardsOverview: per-card sections, name resolution, ordering');
{
    const build = new Function(extract('buildCardsOverview') + '\nreturn buildCardsOverview;')();
    const items = [
        { file_id: 'B chat', avatar: 'Beta.png', mes: 'p', chat_items: 3 },
        { file_id: 'A chat 1', avatar: 'Alpha.png', mes: 'q', chat_items: 5 },
        { file_id: 'G chat', group: 777, mes: 'g', chat_items: 2 },
        { file_id: 'A chat 2', avatar: 'Alpha.png', mes: 'r', chat_items: 1 },
        { file_id: 'stray' },
        null,
    ];
    const chars = [{ avatar: 'Alpha.png', name: 'Alpha Prime' }]; // Beta unresolvable
    const groups = [{ id: 777, name: 'The Party' }];
    const out = build(items, chars, groups);
    assert(out.map(e => e.name).join('|') === 'Beta|Alpha Prime|The Party', 'first-appearance order (mtime), names resolved, avatar fallback strips .png: ' + out.map(e => e.name).join('|'));
    assert(out[1].chats.map(c => c.id).join('|') === 'A chat 1|A chat 2', 'per-card chat order preserved');
    assert(out.every(e => e.chats.length > 0) && out.length === 3, 'root strays and malformed items skipped');
}

console.log('[36] moveChatToCharacter: loss-safe pipeline ordering');
{
    const calls = [];
    const mkFetch = (opts) => async (url, init) => {
        const kind = url.includes('/get') ? 'get' : url.includes('/save') ? 'save' : url.includes('/delete') ? 'delete' : url;
        calls.push(kind);
        if (kind === 'get') return { ok: true, json: async () => (opts.emptyGet ? [] : [{ user_name: 'u', character_name: 'Src' }, { name: 'Src', is_user: false, mes: 'm' }]) };
        if (kind === 'save') return { ok: !opts.saveFail, json: async () => ({ ok: !opts.saveFail }) };
        if (kind === 'delete') return { ok: !opts.deleteFail };
        return { ok: false };
    };
    const deps = 'let settingsObj = { folders: {}, characterFolders: {}, pinned: {}, lastActive: {} };';
    const build = (opts) => new Function('fetch', 'SillyTavern', 'toastr', 'console',
        deps
        + '\nconst getSettings = () => settingsObj; const saveSettings = () => {}; const scheduleSync = () => {};'
        + '\nconst findNativeBlock = () => null; const pruneLastActive = () => {};'
        + '\n' + extract('normalizeChatId') + '\n' + extract('stHeaders') + '\n' + extract('adaptChatForTarget') + '\n' + extract('pickFreeName')
        + '\nasync ' + extract('moveChatToCharacter')
        + '\nreturn { move: moveChatToCharacter, settings: () => settingsObj };')(
        mkFetch(opts), { getContext: () => ({ getRequestHeaders: () => ({}) }) }, { }, console);

    // happy path
    let h = build({});
    let r = await h.move('Tale.jsonl', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === true && calls.join('>') === 'get>save>delete', 'order: read -> write target -> delete source');
    assert(h.settings().lastActive['Dst.png::Tale'] > 0, 'moved chat stamped on the TARGET card');
    // save failure aborts BEFORE delete
    calls.length = 0;
    r = await build({ saveFail: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === false && !calls.includes('delete'), 'write failure -> source untouched, no delete issued');
    // delete failure degrades to duplicate warning, still ok
    calls.length = 0;
    r = await build({ deleteFail: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === true && !!r.warn, 'delete failure -> duplicate + warning, never loss');
    // empty/unreadable source skipped before any write
    calls.length = 0;
    r = await build({ emptyGet: true }).move('Tale', 'Src.png', 'Src', { avatar: 'Dst.png', name: 'Dst' }, new Set());
    assert(r.ok === false && !calls.includes('save'), 'unreadable source -> no write attempted');
}

console.log('[37] v0.12.0 wiring');
{
    const bm = stripComments(extract('bulkMoveToCharacter'));
    assert(bm.includes('isActiveChatFile(fileName)'), 'open chat skipped (autosave would recreate the source file)');
    assert(bm.includes('context.groupId') && bm.includes('supported'), 'group chats guarded with a clear message');
    assert(stripComments(extract('updateBulkBar')).includes('tmc_bulk_movechar'), 'bulk bar carries To card');
    assert(stripComments(extract('showContextMenu')).includes("'movechar'") || stripComments(extract('showContextMenu')).includes('movechar'), 'single-chat menu carries Move to card');
    const ps = stripComments(extract('performSync'));
    assert(ps.includes('if (cardsMode)') && ps.includes('renderCardsTree(proxyRoot)'), 'cards mode replaces the tree');
    assert(stripComments(extract('syncPanelVisibility')).includes('cardsMode = false'), 'cards mode resets on popup close');
    const jc = stripComments(extract('jumpToCard'));
    assert(jc.includes('selectCharacterById(idx)') && jc.includes('openCharacterChat(chatId)'), 'solo jump: select card then open chat');
    assert(jc.includes('openGroupById') && jc.includes('openGroupChat'), 'group jump wired');
    const cb = parseInt(src.match(/const CARDS_FETCH_MAX = (\d+);/)[1], 10);
    assert(cb <= 500, 'cards fetch bounded (' + cb + ')');
}


console.log('[38] Move-to section: contextual items, no more silent no-op entry');
{
    const build = new Function('escapeHtml', extract('buildMoveSectionHtml') + '\nreturn buildMoveSectionHtml;')((s) => s);
    // his exact situation: zero folders, chat uncategorized
    let html = build([], 'uncategorized', false);
    assert(!html.includes('Your chats') && !html.includes('Remove from folder'), 'no folders -> no dead entries');
    assert(html.includes('newfolder-move'), 'New folder… offered instead');
    // in a folder
    html = build([{ fid: 'f1', name: 'Arcs' }, { fid: 'f2', name: 'Side' }], 'f1', false);
    assert(html.includes('Arcs ✓') && html.includes('tmc_ctx_current'), 'current folder marked');
    assert(html.includes('Remove from folder'), 'remove offered when actually in a folder');
    // uncategorized WITH folders existing
    html = build([{ fid: 'f1', name: 'Arcs' }], 'uncategorized', false);
    assert(!html.includes('Remove from folder'), 'no remove when not in a folder');
    // bulk
    html = build([{ fid: 'f1', name: 'Arcs' }], 'uncategorized', true);
    assert(html.includes('Remove from folders') && !html.includes('✓'), 'bulk: plural remove, no current marker');
    // folder names still escaped upstream
    const esc = new Function('escapeHtml', extract('buildMoveSectionHtml') + '\nreturn buildMoveSectionHtml;')((s) => s.replace(/</g, '&lt;'));
    assert(!esc([{ fid: 'f1', name: '<img>' }], 'x', false).includes('<img>'), 'folder names escaped');
}

console.log('[39] formatRelativeTime');
{
    const rel = new Function(extract('formatRelativeTime') + '\nreturn formatRelativeTime;')();
    const now = 1000000000000;
    assert(rel(now - 30 * 1000, now) === 'now', 'sub-minute');
    assert(rel(now - 5 * 60000, now) === '5m ago', 'minutes');
    assert(rel(now - 3 * 3600000, now) === '3h ago', 'hours');
    assert(rel(now - 49 * 3600000, now) === '2d ago', 'days');
}

console.log('[40] Feedback wiring');
{
    const cm = stripComments(extract('showContextMenu'));
    assert(cm.includes('buildMoveSectionHtml(folderList, currentFid, isBulk)'), 'menu uses the contextual builder');
    assert(cm.includes('Already in') && cm.includes('Removed from') && cm.includes('Moved to'), 'every outcome toasts — including the former silent no-op');
    assert(cm.includes('newfolder-move') && cm.includes('createFolder(n)'), 'new-folder-and-move path wired');
    assert(cm.includes('visible when Families is off'), 'family-mode moves explain where the chat went');
    const cf = stripComments(extract('createFolder'));
    assert(cf.includes('return folderId;') && cf.includes('return null;'), 'createFolder returns fid / null');
    const cpb = stripComments(extract('createProxyBlock'));
    assert(cpb.includes('tmc_activity_hint') && cpb.includes('shownDate + 60000'), 'stamp-driven ordering surfaced as a chip when it outranks the visible date');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
