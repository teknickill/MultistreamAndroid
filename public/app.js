/* MultiStream front end.
 *
 * Tiles are absolutely positioned and never moved in the DOM: moving an
 * <iframe> reloads it, which would restart a stream every time you reorder
 * or change layout. Order and layout only change each tile's left/top/size.
 */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = "multistream.v1";
const POLL_OFFLINE_MS = 60_000;     // re-check a channel that isn't live
const POLL_KEY_MS = 5 * 60_000;     // same, when only the backup key works (saves quota)
const RECHECK_ENDED_MS = 15_000;    // a stream ended: look for the next one
const MAX_STREAMS = 16;

const ICON = {
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17.2v.1"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  sets: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
};
// The MultiStream Android app (android-app/) gives the page a bridge for
// picture-in-picture. In a normal browser this is null and nothing changes.
const APP = window.MultiStreamAndroid || null;
let pipMode = false;
window.MultiStreamApp = {
  // Called by the Android app when the PiP window opens or closes.
  setPip(on) {
    pipMode = !!on;
    document.body.classList.toggle("in-pip", pipMode);
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    layout();
    syncPanels();
  },
  // The app calls this after signing in or out, so the chats pick it up.
  // The Android app finished downloading a YouTube page for us.
  ytFetchDone(id, status) { nativeDone(id, status); },
  accountChanged(signedIn) {
    if (signedIn) state.chatAccount = "in";
    save();
    reloadChats();
    renderAccount();
    toast(signedIn ? "Signed in — chats reloaded." : "Signed out of YouTube in this app.");
  },
  // The app asks before going to PiP on Home: only worth it with something playing.
  hasStream() { return state.streams.some((s) => s.player && !state.allPaused); },
};

// Phones and tablets: no hover, so tile controls stay visible and a ⋯ menu
// holds the actions desktop shows on hover.
const TOUCH = window.matchMedia("(hover: none), (pointer: coarse)").matches;

/* ------------------------------------------------------------------ state */
const state = {
  streams: [],            // see makeStream()
  audioMode: "solo",      // "solo" | "mix"
  soloId: null,           // which stream has sound in Solo mode
  layout: "grid",         // "grid" | "focus"
  focusId: null,
  allMuted: false,
  allPaused: false,
  data: "full",           // "full" | "saver" | "min" -- see Data saver below
  chatWidth: 360,         // width of the chat column (computers/tablets)
  chatAccount: "in",      // "in": chat uses your YouTube sign-in; "out": chat always signed out
  dockTab: null,          // which chat shows when there are 3+ (tabs)
};
let ytReady = false;
let ytFailed = false;
let uid = 0;

function makeStream(input, saved = {}) {
  return {
    id: "s" + (++uid),
    input,                        // what was pasted (kept for share links / re-resolving)
    kind: null,                   // "video" | "channel"
    videoId: saved.videoId || null,
    channelId: null,
    label: saved.label || prettyInput(input),
    live: null,
    volume: Number.isFinite(saved.volume) ? saved.volume : 100,
    mixMuted: !!saved.mixMuted,   // per-stream mute in Mix mode
    chatOpen: !!saved.chatOpen,   // this stream's live chat shown beside it
    status: "resolving",          // resolving | waiting | playing | error
    error: null,
    player: null,
    el: null,
    pollTimer: null,
  };
}

function prettyInput(input) {
  const s = String(input).trim();
  const m = s.match(/@[A-Za-z0-9._-]+/);
  if (m) return m[0];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:/i.test(s) ? s : "https://" + s);
    return (u.searchParams.get("v") || u.pathname.split("/").filter(Boolean).pop() || s).slice(0, 40);
  } catch { return s.slice(0, 40); }
}

/* ------------------------------------------------------------ persistence */
function save() {
  const data = {
    streams: state.streams.map((s) => ({ input: s.input, label: s.label, volume: s.volume, mixMuted: s.mixMuted, chatOpen: s.chatOpen })),
    audioMode: state.audioMode,
    layout: state.layout,
    data: state.data,
    chatWidth: state.chatWidth,
    chatAccount: state.chatAccount,
    soloIndex: state.streams.findIndex((s) => s.id === state.soloId),
    focusIndex: state.streams.findIndex((s) => s.id === state.focusId),
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode etc. */ }
}

function load() {
  const params = new URLSearchParams(location.search);
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { data = {}; }
  let list = Array.isArray(data.streams) ? data.streams : [];
  if (params.get("s")) {
    // A shared link wins over what this browser remembered.
    const chats = new Set((params.get("chat") || "").split(",").filter(Boolean).map(Number));
    list = params.get("s").split(",").map((x, i) => ({ input: decodeURIComponent(x), chatOpen: chats.has(i + 1) }))
      .filter((x) => x.input.trim());
    if (params.get("layout") === "focus") data.layout = "focus";
    history.replaceState(null, "", location.pathname);
  }
  state.audioMode = data.audioMode === "mix" ? "mix" : "solo";
  // First visit on a phone with the browser's Data Saver / Lite mode on: start in Saver.
  const saveData = navigator.connection && navigator.connection.saveData;
  state.data = ["full", "saver", "min"].includes(data.data) ? data.data : (saveData ? "saver" : "full");
  if (Number.isFinite(data.chatWidth)) state.chatWidth = data.chatWidth;
  state.chatAccount = data.chatAccount === "out" ? "out" : "in";
  state.layout = data.layout === "focus" ? "focus" : "grid";
  for (const item of list.slice(0, MAX_STREAMS)) {
    if (item && typeof item.input === "string") state.streams.push(makeStream(item.input, item));
  }
  const at = (i) => (Number.isInteger(i) && state.streams[i] ? state.streams[i].id : null);
  state.soloId = at(data.soloIndex) || (state.streams[0] && state.streams[0].id) || null;
  state.focusId = at(data.focusIndex) || (state.streams[0] && state.streams[0].id) || null;
}

function shareUrl() {
  const s = state.streams.map((x) => encodeURIComponent(x.input)).join(",");
  const chats = state.streams.map((x, i) => (x.chatOpen ? i + 1 : 0)).filter(Boolean);
  const extra = (state.layout === "focus" ? "&layout=focus" : "") + (chats.length ? `&chat=${chats.join(",")}` : "");
  return `${location.origin}${location.pathname}?s=${s}${extra}`;
}

/* --------------------------------------------------------- YouTube player */
function loadYouTubeApi() {
  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    for (const s of state.streams) if (s.videoId && !s.player && s.status !== "error") createPlayer(s);
  };
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.onerror = () => {
    ytFailed = true;
    toast("Couldn't load YouTube's player. Check your connection or ad-blocker, then reload.", true);
    for (const s of state.streams) if (s.videoId) setStatus(s, "error", "YouTube's player didn't load.");
  };
  document.head.appendChild(tag);
}

function createPlayer(s) {
  if (!ytReady || !s.videoId || !s.el) return;
  const host = $(".player", s.el);
  host.innerHTML = "";
  const target = document.createElement("div");
  host.appendChild(target);
  setStatus(s, "playing");
  s.player = new YT.Player(target, {
    videoId: s.videoId,
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: 1,
      mute: 1,              // browsers only autoplay muted; sound is applied after
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => { s.playWanted = undefined; applyAudio(); refreshTitle(s); },
      onStateChange: (e) => onPlayerState(s, e.data),
      onError: (e) => onPlayerError(s, e.data),
    },
  });
}

function destroyPlayer(s) {
  if (s.player && s.player.destroy) { try { s.player.destroy(); } catch { /* already gone */ } }
  s.player = null;
}

function refreshTitle(s) {
  try {
    const d = s.player && s.player.getVideoData && s.player.getVideoData();
    if (d && d.author && s.kind === "video" && s.label === prettyInput(s.input)) {
      s.label = d.author;
      renderTileHeader(s);
      save();
      renderTileChat(s);
    }
  } catch { /* player not ready */ }
}

function onPlayerState(s, code) {
  // 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  if (code === 1) refreshTitle(s);
  // Autoplay can start a stream that Data saver wants stopped.
  if ((code === 1 || code === 3) && s.playWanted === false && state.data !== "full") holdStream(s);
  if (code === 0 && s.kind === "channel") {
    // That stream ended. When the channel starts its next one, follow it.
    toast(`${s.label}'s stream ended — watching for the next one.`);
    clearTimeout(s.pollTimer);
    s.pollTimer = setTimeout(() => resolveStream(s, true), RECHECK_ENDED_MS);
  }
  updateGlobalButtons();
}

const PLAYER_ERRORS = {
  2: "That video ID isn't valid.",
  5: "This video can't play in the embedded player.",
  100: "This video is private or was removed.",
  101: "The owner doesn't allow this stream to be embedded.",
  150: "The owner doesn't allow this stream to be embedded.",
  153: "YouTube refused to play this here (embedding restricted).",
};
function onPlayerError(s, code) {
  destroyPlayer(s);
  setStatus(s, "error", PLAYER_ERRORS[code] || `YouTube player error ${code}.`);
}

/* ------------------------------------------- where YouTube data comes from */
// Video and chat always stream straight from YouTube to the viewer. Only two
// small lookups need help, because a web page can't read youtube.com itself:
// search, and "what is @handle streaming right now". Tried in order:
//   1. the Android app: downloads the YouTube page on the phone itself
//   2. the relay (config.js relayUrl): a tiny Cloudflare Worker
//   3. this site's own /api (only when it runs as `node server.js`)
//   4. LAST RESORT, only if installed: the Data API key add-on (ytkey.js,
//      shipped separately). Not part of the normal app.
const CFG = window.MULTISTREAM_CONFIG || {};
const YTC = window.YTCore;   // not "YT": that is YouTube's player library
const NOT_SET_UP = "Looking up channels and searching aren't set up on this site yet. Pasting a video link still works.";
let siteApi = true;              // switches off after the first miss (static hosting)
const nativeWaits = new Map();
let nativeSeq = 0;

function nativeGetText(url) {
  return new Promise((resolve, reject) => {
    const id = `f${++nativeSeq}`;
    const timer = setTimeout(() => {
      nativeWaits.delete(id);
      reject(YTC.httpError(504, "YouTube took too long to answer."));
    }, 15000);
    nativeWaits.set(id, { resolve, reject, timer });
    APP.ytFetch(id, url);
  });
}

function nativeDone(id, status) {
  const body = APP && APP.ytFetchTake ? APP.ytFetchTake(id) : "";   // always take it: frees the app's copy
  const w = nativeWaits.get(id);
  if (!w) return;
  nativeWaits.delete(id);
  clearTimeout(w.timer);
  if (status > 0) w.resolve({ status, text: body || "" });
  else w.reject(YTC.httpError(502, body || "Couldn't reach YouTube."));
}

const relayBase = () => String(CFG.relayUrl || "").trim().replace(/\/+$/, "");
const hasNative = () => !!(APP && APP.ytFetch && APP.ytFetchTake);
const hasBackup = () => !!(window.YTKey && window.YTKey.hasKey());

async function jsonFrom(url, isSite) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!body) {
    // A static host answers /api with an HTML "not found": not an answer about the input.
    if (isSite) { siteApi = false; throw YTC.httpError(503, NOT_SET_UP); }
    throw YTC.httpError(503, `Lookup service answered ${res.status}.`);
  }
  if (!res.ok) throw YTC.httpError(res.status, body.error || `Error ${res.status}`);
  return body;
}

// Tries each way in turn; stops early on an answer about the input itself
// ("that channel doesn't exist").
async function firstWorking(ways) {
  let last = null;
  for (const [via, run] of ways) {
    if (!run) continue;
    try { return { value: await run(), via }; } catch (e) { if (YTC.isFinal(e)) throw e; last = e; }
  }
  throw last || YTC.httpError(503, NOT_SET_UP);
}

async function ytResolve(input, fresh) {
  const c = YTC.classify(input);
  if (c.kind !== "channel") return { value: await YTC.resolve(input), via: "local" };   // video links: no network
  const q = `q=${encodeURIComponent(input)}${fresh ? "&fresh=1" : ""}`;
  return firstWorking([
    ["app", hasNative() && (() => YTC.resolve(input, { getText: nativeGetText, fresh }))],
    ["relay", relayBase() && (() => jsonFrom(`${relayBase()}/resolve?${q}`))],
    ["site", siteApi && (() => jsonFrom(`/api/resolve?${q}`, true))],
    ["key", hasBackup() && (() => YTC.resolve(input, { fallback: (c) => window.YTKey.resolve(c), fresh }))],
  ]);
}

async function ytSearch(q, live) {
  const qs = `q=${encodeURIComponent(q)}&live=${live ? 1 : 0}`;
  const got = await firstWorking([
    ["app", hasNative() && (() => YTC.search(q, { live, getText: nativeGetText }))],
    ["relay", relayBase() && (() => jsonFrom(`${relayBase()}/search?${qs}`))],
    ["site", siteApi && (() => jsonFrom(`/api/search?${qs}`, true))],
    ["key", hasBackup() && (() => YTC.search(q, { live, fallback: (sq, sl) => window.YTKey.search(sq, sl) }))],
  ]);
  return got.value;
}

// Offline channels are re-checked every minute, or every 5 when only the
// backup key works (each check costs quota).
const offlineDelay = (s) => (s.lookupVia === "key" ? POLL_KEY_MS : POLL_OFFLINE_MS);

/* --------------------------------------------------------------- resolving */
async function resolveStream(s, fresh = false) {
  clearTimeout(s.pollTimer);
  if (!s.videoId || fresh) setStatus(s, s.videoId ? s.status : "resolving");
  let r;
  try {
    const got = await ytResolve(s.input, fresh);
    r = got.value;
    s.lookupVia = got.via;
  } catch (e) {
    if (!state.streams.includes(s)) return;
    if (s.kind === "channel" || s.status === "waiting") {
      // A hiccup while following a channel: keep trying quietly.
      s.pollTimer = setTimeout(() => resolveStream(s, true), offlineDelay(s));
      return;
    }
    setStatus(s, "error", e.message || "Couldn't look that up.");
    return;
  }
  if (!state.streams.includes(s)) return;   // removed while we waited
  s.kind = r.kind;
  if (r.kind === "channel") {
    s.channelId = r.channelId;
    if (r.channelName) s.label = r.channelName;
    renderTileHeader(s);
    renderTileChat(s);
    rememberRecent(s.input, s.label);
    if (r.videoId && (r.live || r.upcoming)) {
      // Was waiting for this channel and it just went live: say so.
      if (r.live && s.wasWaiting) {
        toast(`${s.label} is live now.`, false, { label: "Listen", run: () => giveSound(s) });
      }
      s.wasWaiting = false;
      s.live = r.live;
      if (r.videoId !== s.videoId || !s.player) {
        s.videoId = r.videoId;
        if (s.player && s.player.loadVideoById) {
          s.player.loadVideoById(r.videoId);
          setStatus(s, "playing");
        } else {
          createPlayer(s);
        }
        renderTileChat(s);
      }
      if (r.upcoming) s.pollTimer = setTimeout(() => resolveStream(s, true), offlineDelay(s));
    } else {
      s.live = false;
      if (!s.player) {
        setStatus(s, "waiting");
        s.wasWaiting = true;
      }
      s.pollTimer = setTimeout(() => resolveStream(s, true), offlineDelay(s));
    }
  } else {
    s.videoId = r.videoId;
    if (!s.player) createPlayer(s);
  }
  save();
}

/* ------------------------------------------------------------------ tiles */
function buildTile(s) {
  const el = document.createElement("div");
  el.className = "tile";
  el.dataset.id = s.id;
  el.innerHTML = `
    <div class="vid">
    <div class="player"></div>
    <div class="data-off" hidden><img alt="" decoding="async"><span></span></div>
    <div class="hit" title="Click: give this stream the sound · Double-click: full screen"></div>
    <div class="tile-msg" hidden></div>
    <div class="tile-top">
      <div class="tile-name" draggable="true" title="Drag to reorder">
        <span class="tile-num"></span><span class="live-dot" hidden>LIVE</span><span class="label"></span><span class="chip-sound" hidden>${ICON.sound}</span>
      </div>
      <button type="button" class="tile-btn" data-act="chat" title="Show chat">${ICON.chat}</button>
      <button type="button" class="tile-btn touch-only" data-act="menu" title="More">${ICON.more}</button>
      <button type="button" class="tile-btn hover-only" data-act="focus" title="Make this the big one">${ICON.focus}</button>
      <button type="button" class="tile-btn hover-only" data-act="reload" title="Reload this stream">${ICON.reload}</button>
      <button type="button" class="tile-btn hover-only" data-act="open" title="Open on YouTube">${ICON.open}</button>
      <button type="button" class="tile-btn danger hover-only" data-act="remove" title="Remove">${ICON.close}</button>
    </div>
    <div class="tile-bottom">
      <input class="tile-vol" type="range" min="0" max="100" step="1" aria-label="Volume" title="Volume">
      <button type="button" class="tile-btn" data-act="audio"></button>
    </div>
    </div>
    <div class="tile-chat" hidden></div>`;
  s.el = el;

  $(".hit", el).addEventListener("click", () => {
    const held = s.el.classList.contains("data-held");
    // Tap again to hide, like YouTube (but not the one-time intro showing).
    if (TOUCH && s.el.classList.contains("ui") && !held && !s.introUi) hideControls(s);
    else showControls(s);
    s.introUi = false;
    // Solo: clicking a stream gives it the sound. Mix: sound stays as you set it
    // (except a stream paused to save data, which this starts).
    if (state.audioMode === "solo" || held) giveSound(s);
    if (s.player && s.player.getPlayerState && s.player.getPlayerState() === 2) s.player.playVideo();
  });
  // Controls show while the mouse moves over a stream, then fade (like a video player).
  el.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    s.overControls = !!e.target.closest(".tile-top .tile-btn, .tile-bottom");
    showControls(s);
  });
  $(".hit", el).addEventListener("dblclick", () => toggleFullscreen(s));
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    showControls(s);
    const act = btn.dataset.act;
    if (act === "remove") removeStream(s);
    else if (act === "focus") { state.focusId = s.id; setLayout("focus"); }
    else if (act === "reload") { destroyPlayer(s); s.status = "resolving"; resolveStream(s, true); }
    else if (act === "open") window.open(youtubeUrl(s), "_blank", "noopener");
    else if (act === "chat") setStreamChat(s, !s.chatOpen);
    else if (act === "chat-pop" && s.videoId) openFullChat(s);
    else if (act === "audio") toggleTileAudio(s);
    else if (act === "retry") { s.status = "resolving"; destroyPlayer(s); resolveStream(s, true); }
    else if (act === "menu") openSheet(s);
  });
  const vol = $(".tile-vol", el);
  vol.value = s.volume;
  vol.hidden = state.audioMode !== "mix";
  vol.addEventListener("input", () => {
    showControls(s);
    s.volume = Number(vol.value);
    if (state.audioMode === "mix" && s.mixMuted && s.volume > 0) s.mixMuted = false;
    applyAudio();
    save();
  });

  // Drag a tile by its name onto another to swap places.
  const handle = $(".tile-name", el);
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", s.id);
    e.dataTransfer.effectAllowed = "move";
    document.body.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => {
    document.body.classList.remove("dragging");
    document.querySelectorAll(".drop-target").forEach((t) => t.classList.remove("drop-target"));
  });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target"); });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop-target");
    const from = state.streams.findIndex((x) => x.id === e.dataTransfer.getData("text/plain"));
    const to = state.streams.indexOf(s);
    if (from < 0 || to < 0 || from === to) return;
    [state.streams[from], state.streams[to]] = [state.streams[to], state.streams[from]];
    layout(); save(); renderDock();
  });

  $("#stage").appendChild(el);
  renderTileHeader(s);
  renderTileStatus(s);
  renderTileChat(s);
  showControls(s, 3500);         // show the buttons once so people know they're there
  s.introUi = true;
  return el;
}

function youtubeUrl(s) {
  if (s.videoId) return `https://www.youtube.com/watch?v=${s.videoId}`;
  if (s.channelId) return `https://www.youtube.com/channel/${s.channelId}/live`;
  return "https://www.youtube.com/";
}

function renderTileHeader(s) {
  if (!s.el) return;
  $(".label", s.el).textContent = s.label;
  $(".tile-num", s.el).textContent = String(state.streams.indexOf(s) + 1);
  $(".live-dot", s.el).hidden = !(s.kind === "channel" && s.live);
  $('[data-act="focus"]', s.el).hidden = state.layout !== "focus" || state.focusId === s.id;
}

function setStatus(s, status, error = null) {
  s.status = status;
  s.error = error;
  renderTileStatus(s);
  syncWakeLock();
}

/* ----------------------------------------------------- keep screen awake */
// In a browser, keep the phone's screen on while something is playing (the
// Android app already does this itself).
let wakeLock = null;
async function syncWakeLock() {
  if (APP || !("wakeLock" in navigator)) return;
  const want = !document.hidden && !state.allPaused && state.streams.some((s) => s.status === "playing");
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch (e) { wakeLock = null; /* refused (battery saver etc.) */ }
}

function renderTileStatus(s) {
  if (!s.el) return;
  const msg = $(".tile-msg", s.el);
  s.el.classList.toggle("waiting", s.status !== "playing");
  if (s.status === "playing") { msg.hidden = true; msg.innerHTML = ""; return; }
  msg.hidden = false;
  const name = escapeHtml(s.label);
  if (s.status === "resolving") {
    msg.innerHTML = `<div class="spinner"></div><div>Finding ${name}…</div>`;
  } else if (s.status === "waiting") {
    msg.innerHTML = `<b>${name} isn't live right now</b>
      <div>Checking every minute — the stream starts here on its own when they go live.</div>
      <button type="button" class="btn" data-act="retry">Check now</button>`;
  } else {
    msg.innerHTML = `<b>${name}</b><div>${escapeHtml(s.error || "Something went wrong.")}</div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn" data-act="retry">Try again</button>
        <button type="button" class="btn" data-act="open">Open on YouTube</button>
      </div>`;
  }
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ----------------------------------------------------------------- layout */
// A stream with its chat open takes a wider (or, on narrow screens, taller)
// slot: the video keeps 16:9 and the chat sits beside or under it.
// Phones: a stream's chat sits under its video, tall. Computers and tablets:
// chats go in a full-height column beside the streams (the chat dock).
let chatBelow = false;     // true on phones, decided per layout pass

function chatInTile() { return window.matchMedia("(max-width: 720px)").matches; }

function aspectOf() { return 16 / 9; }

// Rows of tiles, centred. Tries every row count and keeps the one where the
// tiles cover the most screen. Works for mixed widths, which is what streams
// with chat open need.
function placeRows(items, x0, y0, w, h, gap) {
  const n = items.length;
  if (!n) return;
  const asp = items.map(aspectOf);
  const total = asp.reduce((a, b) => a + b, 0);
  let best = null;
  for (let rows = 1; rows <= n; rows++) {
    // Split in order into `rows` rows of roughly equal total width.
    const groups = [];
    let cur = [], sum = 0, done = 0;
    for (let i = 0; i < n; i++) {
      const left = rows - groups.length;          // rows still to fill, incl. this one
      const remaining = total - done;
      // Start a new row once this one would pass its fair share of the width.
      if (cur.length && left > 1 && sum + asp[i] / 2 > remaining / left) {
        groups.push(cur); done += sum; cur = []; sum = 0;
      }
      cur.push(i); sum += asp[i];
    }
    groups.push(cur);
    if (groups.length !== rows) continue;
    // Each row as tall as its width allows; a short row (fewer tiles than the
    // fullest rows) is capped so its tiles don't outgrow the rest. Then
    // everything shrinks together until the rows fit the height.
    const natural = groups.map((g) => (w - gap * (g.length - 1)) / g.reduce((a, i) => a + asp[i], 0));
    const most = Math.max(...groups.map((g) => g.length));
    const cap = Math.min(...natural.filter((_, k) => groups[k].length === most));
    let heights = natural.map((nh, k) => (groups[k].length < most ? Math.min(nh, cap) : nh));
    const sumH = heights.reduce((a, b) => a + b, 0);
    const room = h - gap * (rows - 1);
    if (room <= 0) continue;
    if (sumH > room) heights = heights.map((x) => x * room / sumH);
    const area = groups.reduce((a, g, k) => a + heights[k] * heights[k] * g.reduce((b, i) => b + asp[i], 0), 0);
    if (!best || area > best.area) best = { area, heights, groups };
  }
  if (!best) return;
  const { heights, groups } = best;
  const totalH = heights.reduce((a, b) => a + b, 0) + gap * (groups.length - 1);
  let top = y0 + (h - totalH) / 2;
  groups.forEach((g, k) => {
    const th = heights[k];
    const rowW = g.reduce((a, i) => a + asp[i] * th, 0) + gap * (g.length - 1);
    let left = x0 + (w - rowW) / 2;
    for (const i of g) {
      const tw = asp[i] * th;
      placeTile(items[i], left, top, tw, th);
      left += tw + gap;
    }
    top += th + gap;
  });
}

function setRect(el, x, y, w, h) {
  el.style.left = Math.round(x) + "px";
  el.style.top = Math.round(y) + "px";
  el.style.width = Math.round(w) + "px";
  el.style.height = Math.round(h) + "px";
}

// Positions a tile, then splits it into video + chat when its chat is open.
function placeTile(s, x, y, w, h) {
  setRect(s.el, x, y, w, h);
  const vid = $(".vid", s.el);
  const chat = $(".tile-chat", s.el);
  s.el.classList.toggle("chat-below", s.chatOpen && chatBelow);
  let vw = w, vh = h;
  if (s.chatOpen && chatBelow) {
    vh = Math.round(Math.min(h, w * 9 / 16));
    Object.assign(vid.style, { width: "100%", height: vh + "px" });
    Object.assign(chat.style, { left: "0", top: vh + "px", width: "100%", height: Math.round(h - vh) + "px" });
  } else {
    Object.assign(vid.style, { width: "100%", height: "100%" });
  }
  s.vidSize = { w: vw, h: vh };
  applyCap(s);
}

/* ------------------------------------------------------------ Data saver */
// YouTube picks a stream's quality from the size of its player. Saver and
// Min make the player itself small and scale it up on screen, so YouTube
// sends a low-quality stream. 356x200 is the smallest player YouTube allows.
const CAPS = { sound: { w: 640, h: 360 }, other: { w: 356, h: 200 } };   // ~360p / ~240p

// Which streams count as "the one you're listening to".
function isActive(s) {
  const audible = state.streams.filter((x) =>
    state.audioMode === "solo" ? x.id === state.soloId : !x.mixMuted && x.volume > 0);
  if (audible.length) return audible.includes(s);
  return s.id === state.soloId;          // everything muted: keep the main one going
}

function applyCap(s) {
  const box = s.el && $(".player", s.el);
  if (!box || !s.vidSize) return;
  const cap = state.data === "full" ? null : (isActive(s) ? CAPS.sound : CAPS.other);
  const { w, h } = s.vidSize;
  if (!cap || w <= cap.w) {
    Object.assign(box.style, { width: "", height: "", transform: "" });
    return;
  }
  const scale = w / cap.w;
  Object.assign(box.style, {
    width: cap.w + "px",
    height: Math.round(h / scale) + "px",
    transform: `scale(${scale})`,
  });
}

function shouldPlay(s) {
  if (state.allPaused) return false;
  if (state.data === "full") return true;
  if (state.data === "min") return isActive(s);
  return isActive(s) || !document.hidden;      // saver: others stop while the tab is hidden
}

function holdStream(s) {
  try { state.allPaused ? s.player.pauseVideo() : s.player.stopVideo(); } catch { /* not ready */ }
}

// Starts/stops players only when what they should be doing changes, so it
// never fights someone pausing a stream in YouTube's own player.
function applyPlayback() {
  for (const s of state.streams) {
    const p = s.player;
    const want = shouldPlay(s);
    const off = !want && state.data === "min" && !state.allPaused && !!s.videoId && s.status === "playing";
    showDataOff(s, off);
    if (!p || !p.playVideo || s.playWanted === want) continue;
    s.playWanted = want;
    try { want ? p.playVideo() : holdStream(s); } catch { /* not ready */ }
  }
}

function showDataOff(s, on) {
  const box = s.el && $(".data-off", s.el);
  if (!box) return;
  box.hidden = !on;
  s.el.classList.toggle("data-held", on);
  if (!on) return;
  $("span", box).textContent = `Paused to save data · ${TOUCH ? "Tap" : "Click"} to watch`;
  // YouTube's live thumbnail, refreshed once a minute (a few KB, not a stream).
  const src = `https://i.ytimg.com/vi/${s.videoId}/hqdefault_live.jpg?m=${Math.floor(Date.now() / 60000)}`;
  const img = $("img", box);
  if (img.getAttribute("src") !== src) img.src = src;
}

function setDataMode(mode) {
  state.data = mode;
  document.querySelectorAll("[data-quality]").forEach((b) => b.classList.toggle("on", b.dataset.quality === mode));
  state.streams.forEach(applyCap);
  applyPlayback();
  save();
}

// Every layout pass also keeps a full-screen stream fitted to the screen.
function layout() {
  layoutPage();
  if (document.fullscreenElement) fitFullscreen();
  syncPanelsFor(400);        // tiles slide into place (CSS transition): follow them
}

/* ------------------------------------- native chats (Android app only) */
// In the app, each live chat is YouTube's own chat page, drawn by the app over
// the chat area: a real YouTube page, not a frame inside ours, so every option
// works with the app's login. This page keeps an empty placeholder there and
// tells the app exactly where it is, every time anything moves.
// "Signed out" chat mode keeps the old frame (it needs no-cookie frames).
const nativeChats = () => !!(APP && APP.panelOpen && APP.panelPlace && APP.panelClose) && state.chatAccount !== "out";
const panelUrls = new Map();   // stream id -> URL the app is showing
function panelOpen(s, url) {
  if (panelUrls.get(s.id) === url) return;
  panelUrls.set(s.id, url);
  APP.panelOpen(s.id, url);
}
function panelClose(id) {
  if (!panelUrls.has(id)) return;
  panelUrls.delete(id);
  APP.panelClose(id);
  syncPanels();
}
let panelRaf = 0;
let panelUntil = 0;
let lastPlace = null;
function syncPanels() {
  if (!APP || !APP.panelPlace || panelRaf) return;
  panelRaf = requestAnimationFrame(() => {
    panelRaf = 0;
    placePanels();
    if (performance.now() < panelUntil) syncPanels();
  });
}
function syncPanelsFor(ms) {
  panelUntil = Math.max(panelUntil, performance.now() + ms);
  syncPanels();
}
// Something drawn by this page is on top (a menu, dialog, search results):
// the app's chats would cover it, so they step aside meanwhile.
function panelsCovered() {
  return pipMode || !!document.querySelector("dialog[open]") || !$("#results").hidden;
}
function placePanels() {
  if (!APP || !APP.panelPlace) return;
  const dpr = window.devicePixelRatio || 1;
  const px = (v) => Math.round(v * dpr);
  const covered = panelsCovered();
  const fs = document.fullscreenElement;
  const parts = [];
  for (const id of panelUrls.keys()) {
    const s = state.streams.find((x) => x.id === id);
    const body = s && s.chatPane && s.chatPane.isConnected ? $(".chat-body", s.chatPane) : null;
    let show = !!body && !covered && (!fs || fs.contains(body));
    let r = null, c = null;
    if (show) {
      r = body.getBoundingClientRect();
      // Only the part inside its area shows (the stream list scrolls under the top bar).
      const area = fs || body.closest("#stage, #chatDock") || document.documentElement;
      c = area.getBoundingClientRect();
      show = r.width > 40 && r.height > 40;
    }
    if (!show) { parts.push(`${id},0,0,0,0,0,0,0,0,0`); continue; }
    const x1 = Math.max(r.left, c.left), y1 = Math.max(r.top, c.top);
    const x2 = Math.min(r.right, c.right), y2 = Math.min(r.bottom, c.bottom);
    const vis = x2 - x1 > 40 && y2 - y1 > 40;
    parts.push([id, vis ? 1 : 0, px(x1), px(y1), px(x2 - x1), px(y2 - y1),
      px(r.left - x1), px(r.top - y1), px(r.width), px(r.height)].join(","));
  }
  const msg = parts.join(";");
  if (msg === lastPlace) return;
  lastPlace = msg;
  APP.panelPlace(msg);
}

function layoutPage() {
  const stage = $("#stage");
  const gap = 8;
  const W = stage.clientWidth - gap * 2;
  const H = stage.clientHeight - gap * 2;
  const list = state.streams.filter((s) => s.el);   // tiles still being built are skipped
  chatBelow = chatInTile();
  $("#empty").hidden = list.length > 0;
  list.forEach(renderTileHeader);

  // Picture-in-picture (Android app): only the stream you're hearing, filling
  // the little window. The others stay loaded behind it, so they pick up
  // instantly when you come back.
  stage.classList.toggle("pip", pipMode);
  if (pipMode && list.length) {
    const main = list.find(isActive) || list[0];
    stage.classList.remove("stack");
    chatBelow = false;               // no chat in the tiny window
    for (const s of list) {
      s.el.classList.toggle("pip-main", s === main);
      if (s !== main) { placeTile(s, 0, 0, stage.clientWidth, stage.clientHeight); continue; }
      const w = Math.min(stage.clientWidth, stage.clientHeight * 16 / 9);
      const h = w * 9 / 16;
      placeTile(s, (stage.clientWidth - w) / 2, (stage.clientHeight - h) / 2, w, h);
    }
    return;
  }
  list.forEach((s) => s.el.classList.remove("pip-main"));

  const stack = stage.clientWidth < 720;
  stage.classList.toggle("stack", stack);
  if (!list.length) return;

  if (stack) {
    // Narrow screens: one stream per row at full width, scrolling like a page.
    // In Focus the big one goes first.
    const main = state.layout === "focus" ? list.find((s) => s.id === state.focusId) : null;
    const ordered = main ? [main, ...list.filter((s) => s !== main)] : list;
    const w = stage.clientWidth - gap * 2;
    let y = gap;
    // A stream with its chat open fills exactly one screen: video on top, chat
    // using all the height left below it (no blank band, nothing cut off).
    const chatH = Math.max(320, stage.clientHeight - gap * 2 - Math.round(w * 9 / 16));
    for (const s of ordered) {
      const h = w * 9 / 16 + (s.chatOpen && chatBelow ? chatH : 0);
      placeTile(s, gap, y, w, h);
      y += h + gap;
    }
    return;
  }

  if (state.layout === "focus" && list.length > 1) {
    const main = list.find((s) => s.id === state.focusId) || list[0];
    state.focusId = main.id;
    const rest = list.filter((s) => s !== main);
    const wide = W / H > 1.25;
    if (wide) {
      // Big one on the left, the rest in a column on the right.
      const restAsp = Math.max(...rest.map(aspectOf));
      const sideW = Math.max(220, Math.min(W * 0.26 * (restAsp / (16 / 9)), W * 0.45));
      placeRows([main], gap, gap, W - sideW - gap, H, gap);
      placeRows(rest, gap + W - sideW, gap, sideW, H, gap);
    } else {
      const stripH = Math.max(110, Math.min(H * 0.24, 240));
      placeRows([main], gap, gap, W, H - stripH - gap, gap);
      placeRows(rest, gap, gap + H - stripH, W, stripH, gap);
    }
  } else {
    placeRows(list, gap, gap, W, H, gap);
  }
}

/* ------------------------------------------------------------------ audio */
function audioUnlocked() {
  return !navigator.userActivation || navigator.userActivation.hasBeenActive;
}

function wantsSound(s) {
  if (state.allMuted) return false;
  if (state.audioMode === "solo") return s.id === state.soloId;
  return !s.mixMuted && s.volume > 0;
}

function applyAudio() {
  const unlocked = audioUnlocked();
  let anyWanted = false;
  for (const s of state.streams) {
    const want = wantsSound(s);
    anyWanted = anyWanted || want;
    const p = s.player;
    if (p && p.mute && p.getPlayerState) {
      try {
        if (want && unlocked) { p.setVolume(s.volume); p.unMute(); } else p.mute();
        s.applied = { muted: !(want && unlocked), volume: s.volume };
        s.drift = 0;
      } catch { /* not ready yet */ }
    }
    if (s.el) {
      s.el.classList.toggle("hearing", want && state.audioMode === "solo");
      $(".chip-sound", s.el).hidden = !(want && state.streams.length > 1);
      const btn = $('[data-act="audio"]', s.el);
      btn.innerHTML = want ? ICON.sound : ICON.muted;
      btn.classList.toggle("on", want);
      btn.title = state.audioMode === "solo" ? (want ? "This stream has the sound" : "Give this stream the sound")
        : (want ? "Mute" : "Unmute");
      $(".tile-vol", s.el).value = s.volume;
    }
  }
  const notice = $("#notice");
  const needClick = anyWanted && !unlocked && state.streams.some((s) => s.player);
  notice.hidden = !needClick;
  notice.textContent = needClick ? `Your browser starts pages silent — ${TOUCH ? "tap" : "click"} anywhere to turn the sound on.` : "";
  updateGlobalButtons();
  state.streams.forEach(applyCap);
  applyPlayback();
}

// People also use the mute button and volume slider inside each YouTube
// player. Without this the app would undo those on the next click. Once a
// player stays different from what the app last set (two checks in a row,
// so the app's own change has time to land), follow the player instead.
function syncFromPlayers() {
  if (!audioUnlocked()) return;
  let changed = false;
  for (const s of state.streams) {
    const p = s.player, a = s.applied;
    if (!p || !p.isMuted || !a) continue;
    let m, v;
    try { m = p.isMuted(); v = Math.round(p.getVolume()); } catch { continue; }
    if (typeof m !== "boolean" || !Number.isFinite(v)) continue;
    if (m === a.muted && (m || Math.abs(v - a.volume) <= 1)) { s.drift = 0; continue; }
    if (++s.drift < 2) continue;
    s.drift = 0;
    if (state.audioMode === "mix") {
      s.mixMuted = m;
      if (!m && v > 0) s.volume = v;
    } else if (!m) {
      state.soloId = s.id;            // unmuted in its own player: it gets the sound
      state.allMuted = false;
      if (v > 0) s.volume = v;
    } else if (s.id === state.soloId) {
      state.allMuted = true;          // muted the one with sound: everything quiet
    }
    changed = true;
  }
  if (changed) { applyAudio(); save(); }
}

function giveSound(s) {
  if (state.audioMode === "solo") state.soloId = s.id;
  else s.mixMuted = false;
  state.allMuted = false;
  applyAudio(); save();
}

function toggleTileAudio(s) {
  if (state.audioMode === "solo") {
    if (state.soloId === s.id && !state.allMuted) state.allMuted = true;
    else { state.soloId = s.id; state.allMuted = false; }
  } else {
    s.mixMuted = !s.mixMuted;
    if (!s.mixMuted && s.volume === 0) s.volume = 50;
    state.allMuted = false;
  }
  applyAudio(); save();
}

/* ------------------------------------------------------------ stream list */
function addStreams(text) {
  const inputs = String(text).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  let added = 0;
  for (const input of inputs) {
    const r = addOne(input);
    if (r === "full") break;
    if (r === "added") added++;
  }
  if (added) { layout(); save(); applyAudio(); updateGlobalButtons(); }
  return added;
}

// Adds one stream; returns "added", "dupe" or "full". Callers lay out/save.
function addOne(input, saved = {}) {
  if (state.streams.length >= MAX_STREAMS) {
    toast(`Up to ${MAX_STREAMS} streams at once.`, true);
    return "full";
  }
  const vid = videoIdOf(input);
  const dupe = state.streams.find((s) => s.input.toLowerCase() === input.toLowerCase() || (vid && s.videoId === vid));
  if (dupe) {
    toast(`${dupe.label} is already on screen.`);
    return "dupe";
  }
  const s = makeStream(input, saved);
  state.streams.push(s);
  if (!state.soloId) state.soloId = s.id;
  if (!state.focusId) state.focusId = s.id;
  buildTile(s);
  resolveStream(s);
  return "added";
}

function videoIdOf(input) {
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  const m = String(input).match(/(?:youtu\.be\/|[?&]v=|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/* ---------------------------------------------------------------- search */
// Words go to YouTube search; links, @handles and IDs are added directly.
function isLinkish(t) {
  return /^@[\w.-]{3,}$/.test(t) || /youtu\.?be|youtube\.com/i.test(t) || /^UC[\w-]{22}$/.test(t) ||
    (/^[\w-]{11}$/.test(t) && /[0-9A-Z_-]/.test(t) && !/^[A-Za-z]+$/.test(t));
}
function wantsSearch(text) {
  const tokens = String(text).split(/[\s,]+/).filter(Boolean);
  return tokens.length > 0 && !tokens.every(isLinkish);
}

let searchLive = true;
let lastQuery = "";
let searchSeq = 0;

async function runSearch(q) {
  lastQuery = q;
  const box = $("#results");
  box.hidden = false;
  box.innerHTML = searchHeader() + `<div class="results-msg"><div class="spinner"></div>Searching…</div>`;
  const seq = ++searchSeq;
  let data;
  try {
    data = await ytSearch(q, searchLive);
  } catch (e) {
    if (seq !== searchSeq) return;
    box.innerHTML = searchHeader() + `<div class="results-msg">${escapeHtml(e.message || "Search failed.")}</div>`;
    return;
  }
  if (seq !== searchSeq) return;   // a newer search finished first
  const items = data.results || [];
  if (!items.length) {
    box.innerHTML = searchHeader() + `<div class="results-msg">${searchLive
      ? `Nobody's live for “${escapeHtml(q)}” right now. Try <b>All videos</b>.`
      : `No videos found for “${escapeHtml(q)}”.`}</div>`;
    return;
  }
  box.innerHTML = searchHeader() + `<div class="results-list">${items.map(resultRow).join("")}</div>`;
  box.querySelectorAll("img[data-fallback]").forEach((img) => img.addEventListener("error", () => {
    if (img.dataset.fallback) { img.src = img.dataset.fallback; img.dataset.fallback = ""; }
  }, { once: false }));
}

function searchHeader() {
  return `<div class="results-head">
    <div class="seg" role="group" aria-label="Search for">
      <button type="button" data-live="1" class="${searchLive ? "on" : ""}">Live now</button>
      <button type="button" data-live="0" class="${searchLive ? "" : "on"}">All videos</button>
    </div>
    <button type="button" class="tile-btn small" data-results="close" title="Close">${ICON.close}</button>
  </div>`;
}

function resultRow(r) {
  const added = state.streams.some((s) => s.videoId === r.videoId || s.input === r.videoId);
  const status = r.live ? `<span class="live-dot">LIVE</span>${r.viewers ? ` ${escapeHtml(r.viewers)}` : ""}`
    : r.upcoming ? `<span class="soon">Upcoming</span>` : escapeHtml(r.length || "");
  return `<div class="result" data-video="${r.videoId}" data-channel="${r.channelId || ""}" data-handle="${escapeHtml(r.channelHandle || "")}"
      data-title="${escapeHtml(r.title)}" data-name="${escapeHtml(r.channel)}">
    <img src="${escapeHtml(r.thumb || "")}" data-fallback="${escapeHtml(r.thumbFallback || "")}" alt="" loading="lazy">
    <div class="result-text">
      <div class="result-title">${escapeHtml(r.title)}</div>
      <div class="result-meta">${escapeHtml(r.channel)}${status ? ` · ${status}` : ""}</div>
    </div>
    <div class="result-actions">
      <button type="button" class="btn primary small" data-pick="video" ${added ? "disabled" : ""}>${added ? "Added ✓" : "+ Add"}</button>
      ${r.channelId ? `<button type="button" class="btn small ghost" data-pick="channel"
        title="Follow this channel: when this stream ends, the next one plays here">Follow</button>` : ""}
    </div>
  </div>`;
}

function pickResult(row, kind) {
  const videoId = row.dataset.video;
  const channelId = row.dataset.channel;
  // Follow by @handle when known: the most reliable lookup everywhere.
  const channel = row.dataset.handle || channelId;
  const input = kind === "channel" && channel ? channel : videoId;
  const r = addOne(input, { label: row.dataset.name || undefined });
  if (r !== "added") return;
  layout(); save(); applyAudio(); updateGlobalButtons();
  row.querySelectorAll("[data-pick]").forEach((b) => { b.disabled = true; });
  $('[data-pick="video"]', row).textContent = "Added ✓";
  toast(`Added ${row.dataset.name || "stream"}.`);
}

function closeResults() {
  const box = $("#results");
  box.hidden = true;
  box.innerHTML = "";
  searchSeq++;
}

function bindSearch() {
  const input = $("#addInput");
  const btn = $("#addBtn");
  const relabel = () => { btn.textContent = input.value.trim() && !wantsSearch(input.value) ? "Add" : "Search"; };
  input.addEventListener("input", () => { relabel(); if (!input.value.trim()) showRecents(); });
  input.addEventListener("focus", () => { if (!input.value.trim() && $("#results").hidden) showRecents(); });
  relabel();
  $("#results").addEventListener("click", (e) => {
    const live = e.target.closest("[data-live]");
    if (live) { searchLive = live.dataset.live === "1"; runSearch(lastQuery); return; }
    if (e.target.closest('[data-results="close"]')) { closeResults(); return; }
    const recent = e.target.closest("[data-recent]");
    if (recent && !recent.disabled) {
      if (addStreams(recent.dataset.recent)) { recent.disabled = true; recent.textContent += " ✓"; toast(`Added ${recent.textContent.replace(/ ✓$/, "")}.`); }
      return;
    }
    const pick = e.target.closest("[data-pick]");
    if (pick && !pick.disabled) pickResult(pick.closest(".result"), pick.dataset.pick);
  });
  // Click anywhere else closes the results (on computers; the phone sheet has Close).
  document.addEventListener("pointerdown", (e) => {
    if (!$("#results").hidden && !e.target.closest("#addForm") && !e.target.closest("#toast")) closeResults();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#results").hidden) { e.preventDefault(); closeResults(); } });
  $("#addSheet").addEventListener("close", closeResults);
}

function removeStream(s, { undo = true } = {}) {
  const index = state.streams.indexOf(s);
  const snapshot = { input: s.input, label: s.label, volume: s.volume, mixMuted: s.mixMuted, chatOpen: s.chatOpen };
  clearTimeout(s.pollTimer);
  destroyPlayer(s);
  s.el && s.el.remove();
  if (s.chatPane) { s.chatPane.remove(); s.chatPane = null; }
  panelClose(s.id);
  state.streams = state.streams.filter((x) => x !== s);
  if (state.soloId === s.id) state.soloId = state.streams[0] ? state.streams[0].id : null;
  if (state.focusId === s.id) state.focusId = state.streams[0] ? state.streams[0].id : null;
  renderDock();
  layout(); save(); applyAudio(); updateGlobalButtons();
  if (undo) {
    toast(`Removed ${s.label}.`, false, {
      label: "Undo",
      run: () => {
        if (state.streams.length >= MAX_STREAMS) return;
        const back = makeStream(snapshot.input, snapshot);
        state.streams.splice(Math.min(index, state.streams.length), 0, back);
        buildTile(back); resolveStream(back);
        layout(); save(); applyAudio(); updateGlobalButtons();
      },
    });
  }
}

function moveStream(s, delta) {
  const i = state.streams.indexOf(s);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.streams.length) return;
  [state.streams[i], state.streams[j]] = [state.streams[j], state.streams[i]];
  layout(); save(); renderDock();
}

// Tile buttons appear on demand and fade after a short pause.
function showControls(s, ms = 2500) {
  if (!s.el) return;
  s.hiding = false;
  s.el.classList.add("ui");
  clearTimeout(s.uiTimer);
  s.uiTimer = setTimeout(() => {
    const busy = s.overControls || (s.el.contains(document.activeElement) && document.activeElement.matches(".tile-vol"));
    if (busy) showControls(s, ms); else s.el.classList.remove("ui");
  }, ms);
}

function hideControls(s, delay = 0) {
  if (!s.el || s.hiding) return;
  s.hiding = true;
  clearTimeout(s.uiTimer);
  s.uiTimer = setTimeout(() => {
    s.hiding = false;
    s.el.classList.remove("ui");
    if (s.el.contains(document.activeElement)) document.activeElement.blur();
  }, delay);
}

function toggleFullscreen(s) {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (s.el.requestFullscreen) s.el.requestFullscreen().catch(() => {});
}

// Re-fits when the full-screen box changes size (bars hiding, rotating).
const fsWatch = new ResizeObserver(() => { if (document.fullscreenElement) fitFullscreen(); });

// A full-screen stream is laid out for the whole screen: upright with its
// chat open, video on top and chat filling the rest; sideways, just video.
function fitFullscreen() {
  const el = document.fullscreenElement;
  const s = el && state.streams.find((x) => x.el === el);
  for (const x of state.streams) if (x !== s && x.el) x.el.classList.remove("fs-nochat");
  if (!s) { layoutPage(); fsWatch.disconnect(); return; }
  fsWatch.observe(s.el);
  // Measure the full-screen box itself: in the Android app the page's own
  // height (innerHeight) still excludes the hidden status/navigation bars.
  const r = s.el.getBoundingClientRect();
  const w = Math.round(r.width) || window.innerWidth, h = Math.round(r.height) || window.innerHeight;
  const withChat = s.chatOpen && chatInTile() && h > w;
  const keep = chatBelow;
  chatBelow = withChat;
  placeTile(s, 0, 0, w, h);
  chatBelow = keep;
  s.el.classList.toggle("fs-nochat", !withChat);
}

/* ------------------------------------------------- ⋯ menu (phones/tablets) */
function openSheet(s) {
  const sheet = $("#sheet");
  const i = state.streams.indexOf(s);
  const hearing = wantsSound(s);
  const soundLabel = state.audioMode === "solo"
    ? (hearing ? "Mute" : "Give this stream the sound")
    : (hearing ? "Mute this stream" : "Unmute this stream");
  const items = [
    ["sound", hearing ? ICON.muted : ICON.sound, soundLabel],
    ["chat", ICON.chat, s.chatOpen ? "Hide chat" : "Show chat"],
    state.streams.length > 1 && ["focus", ICON.focus, state.layout === "focus" && state.focusId === s.id ? "Back to grid" : "Make this the big one"],
    i > 0 && ["up", ICON.up, "Move up"],
    i < state.streams.length - 1 && ["down", ICON.down, "Move down"],
    document.fullscreenEnabled && ["full", ICON.full, "Full screen"],
    APP && APP.pipSupported() && ["pip", ICON.pip, "Picture-in-picture"],
    ["reload", ICON.reload, "Reload"],
    ["open", ICON.open, "Open on YouTube"],
    ["remove", ICON.close, "Remove", "danger"],
  ].filter(Boolean);
  $(".sheet-title", sheet).textContent = `${i + 1}. ${s.label}`;
  $(".sheet-list", sheet).innerHTML = items.map(([act, icon, text, cls]) =>
    `<button type="button" class="sheet-item ${cls || ""}" data-sheet="${act}">${icon}<span>${escapeHtml(text)}</span></button>`).join("");
  sheet.onclick = (e) => {
    const b = e.target.closest("[data-sheet]");
    if (!b) { if (e.target === sheet) sheet.close(); return; }
    sheet.close();
    const a = b.dataset.sheet;
    if (a === "sound") toggleTileAudio(s);
    else if (a === "chat") setStreamChat(s, !s.chatOpen);
    else if (a === "focus") {
      if (state.layout === "focus" && state.focusId === s.id) setLayout("grid");
      else { state.focusId = s.id; setLayout("focus"); }
    }
    else if (a === "up") moveStream(s, -1);
    else if (a === "down") moveStream(s, 1);
    else if (a === "full") toggleFullscreen(s);
    else if (a === "pip") { giveSound(s); APP.enterPip(); }
    else if (a === "reload") { destroyPlayer(s); s.status = "resolving"; resolveStream(s, true); }
    else if (a === "open") window.open(youtubeUrl(s), "_blank", "noopener");
    else if (a === "remove") removeStream(s);
  };
  sheet.showModal();
}

/* ---------------------------------------------------------------- toolbar */
function setLayout(mode) {
  state.layout = mode;
  document.querySelectorAll("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === mode));
  layout(); save();
}

function setAudioMode(mode) {
  state.audioMode = mode;
  document.querySelectorAll("[data-audio]").forEach((b) => b.classList.toggle("on", b.dataset.audio === mode));
  document.body.classList.toggle("mix", mode === "mix");
  document.querySelectorAll(".tile-vol").forEach((v) => (v.hidden = mode !== "mix"));
  applyAudio(); save();
}

function togglePauseAll() {
  state.allPaused = !state.allPaused;
  applyPlayback();
  updateGlobalButtons();
  syncWakeLock();
}

/* ------------------------------------------------------ recent channels */
// Channels you've watched, newest first, shown when the search box is empty.
const RECENT_KEY = "multistream.recent";
const RECENT_MAX = 10;
function readList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode */ }
}
function rememberRecent(input, label) {
  if (!input) return;
  const key = input.toLowerCase();
  const list = readList(RECENT_KEY).filter((r) => r && r.input && r.input.toLowerCase() !== key);
  list.unshift({ input, label: label || prettyInput(input) });
  writeList(RECENT_KEY, list.slice(0, RECENT_MAX));
}
function showRecents() {
  const box = $("#results");
  const onScreen = new Set(state.streams.map((s) => s.input.toLowerCase()));
  const list = readList(RECENT_KEY).filter((r) => r && r.input);
  if (!list.length || $("#addInput").value.trim()) return;
  box.hidden = false;
  box.innerHTML = `<div class="results-head"><span class="muted recent-title">Recent</span>
      <button type="button" class="tile-btn small" data-results="close" title="Close">${ICON.close}</button></div>
    <div class="recents">${list.map((r) => {
      const here = onScreen.has(r.input.toLowerCase());
      return `<button type="button" class="chip" data-recent="${escapeHtml(r.input)}" ${here ? "disabled" : ""}>${escapeHtml(r.label)}${here ? " ✓" : ""}</button>`;
    }).join("")}</div>`;
}

/* ------------------------------------------------------------ saved sets */
const SETS_KEY = "multistream.sets";
const SETS_MAX = 20;
function openSets() {
  for (const d of document.querySelectorAll("#panel[open]")) d.close();
  renderSets();
  renderSleep();
  $("#sets").showModal();
}
function renderSets() {
  const sets = readList(SETS_KEY);
  $("#setList").innerHTML = sets.length
    ? sets.map((set, i) => `<div class="set-row">
        <button type="button" class="set-load" data-set="${i}"><b>${escapeHtml(set.name)}</b>
          <span class="muted">${set.items.length} stream${set.items.length === 1 ? "" : "s"}</span></button>
        <button type="button" class="tile-btn small" data-set-del="${i}" title="Delete ${escapeHtml(set.name)}">${ICON.close}</button>
      </div>`).join("")
    : `<p class="muted">No saved sets yet. Add some streams, then name them below.</p>`;
}
function currentItems() {
  return state.streams.map((s) => ({ input: s.input, label: s.label, chatOpen: s.chatOpen, volume: s.volume, mixMuted: s.mixMuted }));
}
function saveSet(name) {
  name = String(name || "").trim().slice(0, 40);
  if (!state.streams.length) { toast("Add some streams first."); return false; }
  if (!name) { toast("Give the set a name."); return false; }
  const sets = readList(SETS_KEY).filter((x) => x && x.name && x.name.toLowerCase() !== name.toLowerCase());
  sets.unshift({ name, items: currentItems(), layout: state.layout });
  writeList(SETS_KEY, sets.slice(0, SETS_MAX));
  toast(`Saved “${name}”.`);
  return true;
}
// Replaces what's on screen; the old streams come back with Undo.
function showItems(items, layoutMode) {
  for (const s of [...state.streams]) removeStream(s, { undo: false });
  for (const it of items.slice(0, MAX_STREAMS)) addOne(it.input, it);
  state.soloId = state.streams[0] ? state.streams[0].id : null;
  state.focusId = state.soloId;
  setLayout(layoutMode === "focus" ? "focus" : "grid");
  layout(); save(); applyAudio(); updateGlobalButtons();
}
function loadSet(i) {
  const set = readList(SETS_KEY)[i];
  if (!set || !Array.isArray(set.items)) return;
  const before = currentItems();
  const beforeLayout = state.layout;
  $("#sets").close();
  showItems(set.items, set.layout);
  toast(`Showing “${set.name}”.`, false, before.length ? { label: "Undo", run: () => showItems(before, beforeLayout) } : null);
}
function deleteSet(i) {
  const sets = readList(SETS_KEY);
  const [gone] = sets.splice(i, 1);
  writeList(SETS_KEY, sets);
  renderSets();
  if (gone) toast(`Deleted “${gone.name}”.`, false, {
    label: "Undo",
    run: () => { const now = readList(SETS_KEY); now.splice(Math.min(i, now.length), 0, gone); writeList(SETS_KEY, now); if ($("#sets").open) renderSets(); },
  });
}

/* ----------------------------------------------------------- sleep timer */
let sleepTimer = null;
let sleepAt = 0;
let sleepTick = null;
function setSleep(minutes) {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepAt = 0;
  if (minutes > 0) {
    sleepAt = Date.now() + minutes * 60000;
    sleepTimer = setTimeout(() => {
      sleepTimer = null; sleepAt = 0;
      if (!state.allPaused) togglePauseAll();
      renderSleep();
      toast("Sleep timer: everything's paused. Good night!");
    }, minutes * 60000);
    toast(`Pausing everything in ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}.`);
  }
  renderSleep();
}
function renderSleep() {
  const left = sleepAt ? Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000)) : 0;
  document.querySelectorAll("[data-sleep]").forEach((b) => b.classList.toggle("on", sleepAt ? false : b.dataset.sleep === "0"));
  $("#sleepLeft").textContent = sleepAt ? `Pausing everything in ${left} min. Pick a time to change it, or Off.` : "Pauses every stream when time's up.";
  $("#setsBtn").classList.toggle("on", !!sleepAt);
}

function updateGlobalButtons() {
  for (const mute of [$("#muteAll"), $("#mMute")]) {
    mute.innerHTML = state.allMuted ? ICON.muted : ICON.sound;
    mute.classList.toggle("on", state.allMuted);
    mute.title = state.allMuted ? "Unmute (M)" : "Mute all (M)";
    mute.dataset.label = state.allMuted ? "Unmute" : "Mute all";
  }
  const play = $("#playAll");
  play.innerHTML = state.allPaused ? ICON.play : ICON.pause;
  play.title = state.allPaused ? "Play all (Space)" : "Pause all (Space)";
  play.dataset.label = state.allPaused ? "Play all" : "Pause all";
  const chat = $("#chatToggle");
  const allOpen = state.streams.length > 0 && state.streams.every((s) => s.chatOpen);
  chat.classList.toggle("on", allOpen);
  chat.title = allOpen ? "Hide every chat (C)" : "Show every stream's chat (C)";
  chat.dataset.label = allOpen ? "Hide all chats" : "Show all chats";
}

/* ------------------------------------------------------------------- chat */
// Each stream has its own chat, opened from its 💬 button. YouTube only serves
// embedded chat to the domain named in embed_domain, and only for streams that
// are live (or have chat replay).
function chatUrl(videoId, popout = false) {
  const base = `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}`;
  return popout ? `${base}&is_popout=1` : `${base}&embed_domain=${encodeURIComponent(location.hostname)}&dark_theme=1`;
}

function setStreamChat(s, open) {
  s.chatOpen = open;
  renderTileChat(s);
  layout(); save(); updateGlobalButtons();
}

function chatPane(s) {
  if (s.chatPane) return s.chatPane;
  const pane = document.createElement("section");
  pane.className = "chat-pane";
  pane.dataset.id = s.id;
  pane.innerHTML = `<div class="chat-head"><span class="tile-num"></span><span class="chat-title"></span>
      <button type="button" class="tile-btn small" data-pane="account" title="YouTube account for chat">${ICON.user}</button>
      <button type="button" class="tile-btn small" data-pane="pop" title="Full chat (all options)">${ICON.open}</button>
      <button type="button" class="tile-btn small" data-pane="close" title="Hide chat">${ICON.close}</button></div>
    <div class="chat-body"></div>`;
  pane.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pane]");
    if (!b) return;
    if (b.dataset.pane === "close") setStreamChat(s, false);
    else if (b.dataset.pane === "account") openAccount();
    else if (s.videoId) openFullChat(s);
  });
  // Point at a chat and its stream lights up, so it's clear which is which.
  // (Its header too: the pointer moving straight onto the chat itself is seen
  // only by YouTube's frame.)
  for (const t of [pane, $(".chat-head", pane)]) {
    t.addEventListener("pointerenter", () => s.el && s.el.classList.add("chat-linked"));
    t.addEventListener("pointerleave", () => s.el && s.el.classList.remove("chat-linked"));
  }
  s.chatPane = pane;
  return pane;
}

function renderTileChat(s) {
  if (!s.el) return;
  const box = $(".tile-chat", s.el);
  const btn = $('[data-act="chat"]', s.el);
  btn.classList.toggle("on", !!s.chatOpen);
  btn.title = s.chatOpen ? "Hide chat" : "Show chat";
  const inTile = chatInTile();
  box.hidden = !(s.chatOpen && inTile);
  if (!s.chatOpen) {
    panelClose(s.id);
    if (s.chatPane) { s.chatPane.remove(); s.chatPane = null; }
    s.el.classList.remove("chat-linked");
    renderDock();
    return;
  }
  const pane = chatPane(s);
  const home = inTile ? box : $("#chatDock .dock-body");
  // Only move it when it has to: moving an iframe reloads it.
  if (pane.parentNode !== home) home.appendChild(pane);
  $(".tile-num", pane).textContent = String(state.streams.indexOf(s) + 1);
  $(".chat-title", pane).textContent = s.label;
  const body = $(".chat-body", pane);
  if (!s.videoId || !nativeChats()) panelClose(s.id);
  if (!s.videoId) {
    if (pane.dataset.video !== "") {
      body.innerHTML = `<div class="chat-empty">Chat shows up here when ${escapeHtml(s.label)} goes live.</div>`;
      pane.dataset.video = "";
    }
  } else if (pane.dataset.video !== s.videoId) {
    pane.dataset.video = s.videoId;
    // "Signed out": the chat frame gets no cookies at all (credentialless), so it
    // never shows your account. "Signed in": it uses your YouTube sign-in.
    if (nativeChats()) {
      // Android app: YouTube's own chat page, drawn by the app right here.
      body.innerHTML = `<div class="chat-empty chat-native">Loading chat…</div>`;
      panelOpen(s, chatUrl(s.videoId, true) + "&dark_theme=1");
    } else {
      const noCookies = state.chatAccount === "out" ? " credentialless" : "";
      body.innerHTML = `<iframe title="Live chat: ${escapeHtml(s.label)}"${noCookies} src="${chatUrl(s.videoId)}"></iframe>`;
    }
  }
  renderDock();
  syncPanels();
}

// The chat column: 1-2 chats stack at full height; 3 or more become tabs so
// each one still gets the whole column.
function renderDock() {
  const dock = $("#chatDock");
  const open = chatInTile() ? [] : state.streams.filter((s) => s.chatOpen && s.chatPane);
  const wasHidden = dock.hidden;
  dock.hidden = open.length === 0;
  dock.style.width = Math.round(clampChatWidth(state.chatWidth)) + "px";
  const tabs = open.length >= 3;
  dock.classList.toggle("tabbed", tabs);
  if (!open.find((s) => s.id === state.dockTab)) {
    state.dockTab = (open.find((s) => s.id === state.soloId) || open[0] || {}).id || null;
  }
  $(".dock-tabs", dock).innerHTML = tabs ? open.map((s) =>
    `<button type="button" role="tab" data-tab="${s.id}" class="${s.id === state.dockTab ? "on" : ""}"
       aria-selected="${s.id === state.dockTab}"><span class="tile-num">${state.streams.indexOf(s) + 1}</span>${escapeHtml(s.label)}</button>`).join("") : "";
  open.forEach((s, i) => {
    s.chatPane.style.order = String(i);           // CSS order, not DOM moves (no reloads)
    s.chatPane.hidden = tabs && s.id !== state.dockTab;
    $(".tile-num", s.chatPane).textContent = String(state.streams.indexOf(s) + 1);
  });
  if (wasHidden !== dock.hidden) layout();
}

function clampChatWidth(w) {
  return Math.max(260, Math.min(w, Math.max(280, window.innerWidth * 0.6)));
}

/* ------------------------------------------------- YouTube account (chat) */
// Embedded chat is a YouTube frame inside this page. Whether it shows you as
// signed in depends on the YouTube login it can see:
//  - Website: your browser's YouTube login. Some browsers/settings hide it from
//    frames inside other sites ("third-party cookies"); the pop-out ↗ never has
//    that problem because it's a normal YouTube window.
//  - Android app: the app keeps its own login (signed in from this dialog).
const SIGNIN_URL = "https://accounts.google.com/ServiceLogin?service=youtube&continue=" +
  encodeURIComponent("https://www.youtube.com/signin?action_handle_signin=true&next=%2F");

function openAccount() {
  renderAccount();
  for (const d of document.querySelectorAll("#panel[open]")) d.close();
  $("#account").showModal();
}

function renderAccount() {
  document.querySelectorAll("[data-account]").forEach((b) => b.classList.toggle("on", b.dataset.account === state.chatAccount));
  const signedOutMode = state.chatAccount === "out";
  $(".account-what").textContent = signedOutMode
    ? "Chats never show your account. You can read along but not type."
    : "Chats use your YouTube sign-in, so you can type, and your memberships and badges show.";
  $("#signInBtn").hidden = signedOutMode;
  $("#signOutBtn").textContent = APP ? "Sign out of YouTube in this app" : "Sign out (show chats signed out)";
  $("#signOutBtn").hidden = !APP && signedOutMode;
  $(".account-note").textContent = APP
    ? "Signing in here only affects this app. If Google says this app or browser may not be secure, use ↗ on a chat to open it in your browser instead, where you're already signed in."
    : "Embedded chats use the YouTube login of this browser. If a chat still shows signed out after signing in, your browser is blocking third-party cookies for this site — use ↗ on the chat (always signed in), or allow third-party cookies for this site.";
}

function setChatAccount(mode) {
  if (mode === state.chatAccount) return;
  state.chatAccount = mode;
  document.body.classList.toggle("native-chats", nativeChats());
  save();
  reloadChats();
  renderAccount();
}

// Re-creates every open chat frame so a new sign-in state takes effect.
function reloadChats() {
  for (const s of state.streams) {
    if (!s.chatPane) continue;
    delete s.chatPane.dataset.video;
    renderTileChat(s);
  }
}

function signIn() {
  if (APP && APP.signIn) { $("#account").close(); APP.signIn(); return; }
  // Website: sign in to YouTube in a normal (first-party) window, then reload the chats.
  const w = window.open(SIGNIN_URL, "ytsignin", "width=520,height=720");
  if (!w) { location.href = SIGNIN_URL; return; }
  const timer = setInterval(() => {
    if (w.closed) { clearInterval(timer); state.chatAccount = "in"; save(); reloadChats(); renderAccount(); }
  }, 800);
  toast("Sign in in the new window, then close it — the chats reload by themselves.");
}

function signOut() {
  if (APP && APP.signOut) { APP.signOut(); return; }
  // Website: we can't (and shouldn't) sign the whole browser out of Google;
  // show the chats signed out instead.
  setChatAccount("out");
  toast("Chats now show signed out. You're still signed in to YouTube elsewhere in this browser.");
}

// The full YouTube chat page (every option: reply, report, block…). In the
// Android app it opens full screen inside the app with the app's login; on
// the website it opens in its own window.
function openFullChat(s) {
  const url = chatUrl(s.videoId, true);
  if (APP && APP.openChat) APP.openChat(url);
  else window.open(url, "_blank", "width=420,height=720");
}

function toggleAllChats() {
  const anyClosed = state.streams.some((s) => !s.chatOpen);
  for (const s of state.streams) { s.chatOpen = anyClosed; renderTileChat(s); }
  layout(); save(); updateGlobalButtons();
}

function bindDock() {
  const dock = $("#chatDock");
  $(".dock-tabs", dock).addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) { state.dockTab = b.dataset.tab; renderDock(); }
  });
  // Drag the left edge to make the chat column wider or narrower.
  const grip = $(".dock-resize", dock);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging", "resizing");
    const move = (ev) => {
      state.chatWidth = clampChatWidth(dock.getBoundingClientRect().right - ev.clientX);
      dock.style.width = Math.round(state.chatWidth) + "px";
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging", "resizing");
      save();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

/* ------------------------------------------------------------------ misc */
let toastTimer;
function toast(text, isError = false, action = null) {
  const t = $("#toast");
  t.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove("show"); action.run(); };
    t.appendChild(b);
  }
  t.classList.toggle("error", isError);
  t.classList.toggle("has-action", !!action);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 3200);
}

async function copyShare() {
  if (!state.streams.length) { toast("Add a stream first."); return; }
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast("Link copied — it opens these streams in this layout."); }
  catch { window.prompt("Copy this link:", url); }
}

function bindUi() {
  $("#muteAll").addEventListener("click", () => { state.allMuted = !state.allMuted; applyAudio(); });
  $("#playAll").addEventListener("click", togglePauseAll);
  $("#chatToggle").innerHTML = ICON.chat;
  $("#chatToggle").addEventListener("click", toggleAllChats);
  $("#shareBtn").innerHTML = ICON.share;
  $("#shareBtn").addEventListener("click", copyShare);
  $("#helpBtn").innerHTML = ICON.help;
  $("#accountBtn").innerHTML = ICON.user;
  $("#setsBtn").innerHTML = ICON.sets;
  $("#setsBtn").addEventListener("click", openSets);
  $("#setForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (saveSet($("#setName").value)) { $("#setName").value = ""; renderSets(); }
  });
  $("#setList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-set-del]");
    if (del) { deleteSet(Number(del.dataset.setDel)); return; }
    const load = e.target.closest("[data-set]");
    if (load) loadSet(Number(load.dataset.set));
  });
  document.querySelectorAll("[data-sleep]").forEach((b) => b.addEventListener("click", () => setSleep(Number(b.dataset.sleep))));
  $("#sets").addEventListener("close", () => { clearInterval(sleepTick); sleepTick = null; });
  $("#setsBtn").addEventListener("click", () => { clearInterval(sleepTick); sleepTick = setInterval(renderSleep, 20000); });
  $("#accountBtn").addEventListener("click", openAccount);
  document.querySelectorAll("[data-account]").forEach((b) => b.addEventListener("click", () => setChatAccount(b.dataset.account)));
  $("#signInBtn").addEventListener("click", signIn);
  $("#signOutBtn").addEventListener("click", signOut);
  $("#account").addEventListener("click", (e) => { if (e.target === $("#account")) $("#account").close(); });
  $("#helpBtn").addEventListener("click", () => $("#help").showModal());
  document.querySelectorAll("[data-layout]").forEach((b) => b.addEventListener("click", () => setLayout(b.dataset.layout)));
  document.querySelectorAll("[data-audio]").forEach((b) => b.addEventListener("click", () => setAudioMode(b.dataset.audio)));
  document.querySelectorAll("[data-quality]").forEach((b) => b.addEventListener("click", () => setDataMode(b.dataset.quality)));
  document.addEventListener("visibilitychange", () => { applyPlayback(); syncWakeLock(); });
  setInterval(() => state.streams.forEach((s) => { const b = s.el && $(".data-off", s.el); if (b && !b.hidden) showDataOff(s, true); }), 60_000);
  $("#notice").addEventListener("click", applyAudio);
  document.querySelectorAll("[data-example]").forEach((b) =>
    b.addEventListener("click", () => { addStreams(b.dataset.example); $("#addSheet").open && $("#addSheet").close(); }));

  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#addInput");
    const text = input.value.trim();
    if (!text) return;
    if (wantsSearch(text)) { runSearch(text); return; }
    closeResults();
    if (addStreams(text)) {
      input.value = "";
      $("#addBtn").textContent = "Search";
      if ($("#addSheet").open) $("#addSheet").close();
    }
  });
  bindSearch();

  // Mouse left a stream (checked page-wide: a button redrawn under the
  // pointer never reports "left"): fade its controls.
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    for (const s of state.streams) {
      if (s.el && s.el.classList.contains("ui") && !s.el.contains(e.target)) { s.overControls = false; hideControls(s, 400); }
    }
  }, { passive: true });

  // Phones: slim bar
  $("#mMenu").innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  $("#mAdd").addEventListener("click", openAdd);
  document.querySelectorAll("[data-open-add]").forEach((b) => b.addEventListener("click", openAdd));
  $("#mMute").addEventListener("click", () => { state.allMuted = !state.allMuted; applyAudio(); });
  $("#mMenu").addEventListener("click", () => $("#panel").showModal());
  for (const d of document.querySelectorAll("dialog.sheet")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });   // tap outside closes
  }
  // Actions in the menu close it (toggles like Sound/Data/Layout keep it open).
  $("#slotActions").addEventListener("click", (e) => {
    const b = e.target.closest("#shareBtn, #helpBtn, #accountBtn, #setsBtn");
    if (b) $("#panel").close();
  });
  const mq = window.matchMedia("(max-width: 720px)");
  mq.addEventListener("change", () => {
    placeToolbar(mq.matches);
    state.streams.forEach(renderTileChat);
    layout();
  });
  bindDock();
  placeToolbar(mq.matches);

  // The first click/key anywhere unlocks sound; apply it right away, once.
  const unlock = () => {
    setTimeout(applyAudio, 0);
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  setInterval(syncFromPlayers, 1000);

  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (/^[1-9]$/.test(k)) {
      const s = state.streams[Number(k) - 1];
      if (s) { state.audioMode === "solo" ? giveSound(s) : toggleTileAudio(s); }
    } else if (k === "m") { state.allMuted = !state.allMuted; applyAudio(); }
    else if (k === "f") setLayout(state.layout === "grid" ? "focus" : "grid");
    else if (k === "c") toggleAllChats();
    else if (k === " ") { e.preventDefault(); togglePauseAll(); }
    else if (k === "/") { e.preventDefault(); openAdd(); }
    else if (k === "?") $("#help").showModal();
  });

  new ResizeObserver(() => layout()).observe($("#stage"));
  document.addEventListener("fullscreenchange", fitFullscreen);
  window.addEventListener("resize", () => { if (document.fullscreenElement) fitFullscreen(); });
  // The page itself never scrolls (only the stream list does). Phones can
  // still nudge it, e.g. to show a focused chat box over the keyboard, and
  // then leave it shifted with the top bar gone. Snap it back.
  const unshift = () => {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollTop || se.scrollLeft) se.scrollTo(0, 0);
    if (document.body.scrollTop) document.body.scrollTop = 0;
  };
  window.addEventListener("scroll", unshift, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", unshift);
}

function bindPanels() {
  if (!APP || !APP.panelPlace) return;
  $("#stage").addEventListener("scroll", syncPanels, { passive: true });
  window.addEventListener("resize", () => syncPanelsFor(300));
  document.addEventListener("fullscreenchange", () => syncPanelsFor(500));
  // Menus, dialogs and search results opening or closing.
  const watch = new MutationObserver(() => syncPanels());
  for (const d of document.querySelectorAll("dialog")) watch.observe(d, { attributes: true, attributeFilter: ["open"] });
  watch.observe($("#results"), { attributes: true, attributeFilter: ["hidden"] });
  new ResizeObserver(() => syncPanels()).observe($("#chatDock"));
  $("#chatDock").addEventListener("click", () => syncPanelsFor(200));   // tab switches
}

function init() {
  document.body.classList.toggle("touch", TOUCH);
  document.body.classList.toggle("android-app", !!APP);
  if (APP && APP.pipSupported()) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn icon"; b.id = "pipBtn";
    b.title = "Picture-in-picture: keep watching in a small window"; b.dataset.label = "Picture-in-picture";
    b.innerHTML = ICON.pip;
    b.addEventListener("click", () => APP.enterPip());
    $(".mobile-actions").insertBefore(b, $("#mMenu"));
  }
  if (APP && APP.panelCloseAll) APP.panelCloseAll();   // left over from before a reload
  load();
  document.body.classList.toggle("native-chats", nativeChats());
  bindUi();
  bindPanels();
  for (const s of state.streams) { buildTile(s); resolveStream(s); }
  setLayout(state.layout);
  setAudioMode(state.audioMode);
  setDataMode(state.data);
  updateGlobalButtons();
  loadYouTubeApi();
  if (!state.streams.length && !isPhoneBar()) $("#addInput").focus();
}

/* ------------------------------------------------- phone bar and menus */
// On phones the Add box and the toolbar move into sheets, so the top bar
// stays one slim row. The same elements are moved (not copied), so every
// button keeps working.
const TOOL_ORDER = ['[aria-label="Audio mode"]', '[aria-label="Data use"]', '[aria-label="Layout"]',
  "#muteAll", "#playAll", "#chatToggle", "#setsBtn", "#shareBtn", "#accountBtn", "#helpBtn"];
function isPhoneBar() { return window.matchMedia("(max-width: 720px)").matches; }

function placeToolbar(phone) {
  const tools = $(".tools");
  const form = $("#addForm");
  const get = (sel) => document.querySelector(sel);
  if (phone) {
    $("#addSlot").appendChild(form);
    $("#slotAudio").appendChild(get(TOOL_ORDER[0]));
    $("#slotData").appendChild(get(TOOL_ORDER[1]));
    $("#slotLayout").appendChild(get(TOOL_ORDER[2]));
    for (const sel of TOOL_ORDER.slice(3)) $("#slotActions").appendChild(get(sel));
  } else {
    for (const d of document.querySelectorAll("#addSheet, #panel")) if (d.open) d.close();
    $(".brand").after(form);
    for (const sel of TOOL_ORDER) tools.appendChild(get(sel));
  }
  document.body.classList.toggle("phone", phone);
}

function openAdd() {
  if (isPhoneBar()) {
    $("#addSheet").showModal();
    setTimeout(() => $("#addInput").focus(), 50);
  } else {
    $("#addInput").focus();
  }
}

init();
