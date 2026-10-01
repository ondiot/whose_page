import { supabase } from "./supabaseClient.js";
import { AVATARS, avatarMarkup } from "./avatars.js";
import { BUILT_IN_TOPICS } from "./topics.js";

const $ = (id) => document.getElementById(id);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_PLAYERS = 8; // room limit
const MAX_CUSTOM_TOPICS = 10;

// ---------------------------------------------------------------------
// state
// ---------------------------------------------------------------------
const state = {
  room: null,        // current room row
  playerId: null,    // my player id
  selectedAvatar: AVATARS[0],
  players: [],        // all players in room
  channel: null,
  timerHandle: null,
  guessTarget: null,  // {assignment, paper, players}
  currentWritingRound: null,
  guessRenderSeq: 0,      // guards against overlapping guessing renders
  submittingGuess: false, // blocks double-clicks while a guess is saving
  revealCards: [],        // one HTML card per paper on the results screen
  revealIndex: 0,         // which paper is showing
  revealRound: null,      // round the current results belong to
};

// The logo stays up through the name, create/join and lobby screens,
// and disappears once the game actually starts (writing/guessing/reveal).
const TITLE_SCREENS = ["name", "mode", "lobby"];

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`screen-${name}`).classList.add("active");
  $("site-title").classList.toggle("hidden", !TITLE_SCREENS.includes(name));
}

function randomCode(len = 5) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Session persistence is intentionally disabled. Every page load starts fresh.
function clearSession() {
  localStorage.removeItem("bp_session");
}

// ---------------------------------------------------------------------
// avatar picker (home screen)
// ---------------------------------------------------------------------
function renderAvatarPicker() {
  const preview = $("avatar-preview");
  if (!preview) return;

  preview.innerHTML = avatarMarkup(state.selectedAvatar, "avatar-svg avatar-preview-img");
  preview.classList.remove("pop");
  void preview.offsetWidth;
  preview.classList.add("pop");
}

function changeAvatar(direction) {
  const current = AVATARS.indexOf(state.selectedAvatar);
  const next = (current + direction + AVATARS.length) % AVATARS.length;
  state.selectedAvatar = AVATARS[next];
  renderAvatarPicker();
}

function continueFromName() {
  const name = $("input-name").value.trim();
  if (!name) return setError("name-error", "Enter your name first.");

  $("mode-name").textContent = name;
  $("mode-avatar").innerHTML = avatarMarkup(state.selectedAvatar, "avatar-svg avatar-mode-img");
  showScreen("mode");
}

function backToName() {
  showScreen("name");
  $("mode-name").textContent = "";
  $("mode-avatar").textContent = "";
}

// ---------------------------------------------------------------------
// create / join
// ---------------------------------------------------------------------
async function createRoom() {
  const name = $("input-name").value.trim();
  if (!name) return setError("name-error", "Enter your name first.");

  let code, existing;
  do {
    code = randomCode();
    ({ data: existing } = await supabase.from("rooms").select("id").eq("code", code).maybeSingle());
  } while (existing);

  const { data: room, error } = await supabase
    .from("rooms")
    .insert({ code })
    .select()
    .single();
  if (error) return setError("name-error", error.message);

  const { data: player, error: pErr } = await supabase
    .from("players")
    .insert({ room_id: room.id, name, avatar: state.selectedAvatar, is_host: true })
    .select()
    .single();
  if (pErr) return setError("name-error", pErr.message);

  clearSession();
  enterRoom(room.id, player.id);
}

async function joinRoom() {
  const name = $("input-name").value.trim();
  const code = $("input-code").value.trim().toUpperCase();
  if (!name) return setError("name-error", "Enter your name first.");
  if (!code) return setError("name-error", "Enter a room code.");

  const { data: room, error } = await supabase.from("rooms").select().eq("code", code).maybeSingle();
  if (error || !room) return setError("name-error", "Room not found.");
  if (room.status !== "lobby") return setError("name-error", "That game already started.");

  const { count } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("room_id", room.id);
  if ((count ?? 0) >= MAX_PLAYERS) return setError("name-error", `Room is full (max ${MAX_PLAYERS} players).`);

  const { data: player, error: pErr } = await supabase
    .from("players")
    .insert({ room_id: room.id, name, avatar: state.selectedAvatar, is_host: false })
    .select()
    .single();
  if (pErr) return setError("name-error", pErr.message);

  clearSession();
  enterRoom(room.id, player.id);
}

function setError(id, msg) { $(id).textContent = msg; setTimeout(() => { $(id).textContent = ""; }, 4000); }

// ---------------------------------------------------------------------
// entering a room + realtime subscription
// ---------------------------------------------------------------------
async function enterRoom(roomId, playerId) {
  state.playerId = playerId;

  const { data: room } = await supabase.from("rooms").select().eq("id", roomId).single();
  state.room = room;

  await refreshPlayers();
  subscribeRealtime(roomId);
  $("room-bar").classList.remove("hidden");
  $("room-bar-code").textContent = room.code;
  renderForStatus();
  await renderPlayerStrip();
}

async function leaveRoom() {
  clearInterval(state.timerHandle);
  state.timerHandle = null;

  if (state.channel) {
    await supabase.removeChannel(state.channel);
  }

  if (isHost()) {
    const next = state.players.find((p) => p.id !== state.playerId);
    if (next) {
      await supabase.from("players").update({ is_host: true }).eq("id", next.id);
    }
  }

  if (state.playerId) {
    await supabase.from("players").delete().eq("id", state.playerId);
  }

  clearSession();
  state.room = null;
  state.players = [];
  state.playerId = null;
  state.channel = null;
  state.guessTarget = null;
  state.currentWritingRound = null;

  $("room-bar").classList.add("hidden");
  $("player-strip").classList.add("hidden");
  $("player-strip").innerHTML = "";
  $("room-bar-code").textContent = "";
  $("input-code").value = "";
  $("write-text").value = "";
  $("write-status").textContent = "";
  $("input-topic").value = "";
  showScreen("name");
}

async function refreshPlayers() {
  const { data } = await supabase.from("players").select().eq("room_id", state.room.id).order("joined_at");
  state.players = data || [];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

async function renderPlayerStrip() {
  const strip = $("player-strip");
  if (!strip || !state.room || !state.playerId) return;

  const status = state.room.status;
  const show = ["writing", "guessing", "reveal"].includes(status);
  strip.classList.toggle("hidden", !show);
  if (!show) return;

  let doneIds = new Set();
  const progress = {}; // playerId -> { total, answered } (guessing phase)

  if (status === "writing") {
    const { data: papers } = await supabase.from("papers")
      .select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
    doneIds = new Set((papers || []).map((p) => p.author_id));
  } else if (status === "guessing") {
    const { data: assignments } = await supabase.from("assignments")
      .select("assigned_to, guessed_player_id").eq("room_id", state.room.id).eq("round", state.room.round);
    (assignments || []).forEach((a) => {
      const pr = (progress[a.assigned_to] ||= { total: 0, answered: 0 });
      pr.total++;
      if (a.guessed_player_id !== null) pr.answered++;
    });
    // a player is done once every paper they were given has a guess
    doneIds = new Set(state.players
      .filter((pl) => { const pr = progress[pl.id]; return !pr || pr.answered >= pr.total; })
      .map((pl) => pl.id));
  } else {
    doneIds = new Set(state.players.map((p) => p.id));
  }

  strip.innerHTML = "";

  state.players.forEach((p) => {
    const card = document.createElement("div");
    const done = doneIds.has(p.id);
    const me = p.id === state.playerId;

    card.className = `player-tab${done ? " done" : ""}${me ? " me" : ""}`;
    card.title = `${p.name} · ${p.score ?? 0} point${p.score === 1 ? "" : "s"}`;

    const statusLabel =
      status === "writing" ? (done ? "Done" : "Writing…") :
      status === "guessing" ? (done ? "Done" : `${progress[p.id]?.answered ?? 0}/${progress[p.id]?.total ?? 0}`) :
      "Done";

    card.innerHTML = `
      <div class="player-tab-avatar">${avatarMarkup(p.avatar, "avatar-svg")}</div>
      <div class="player-tab-info">
        <div class="player-tab-name">${escapeHtml(p.name)}</div>
        <div class="player-tab-status"><span class="player-status-dot"></span>${statusLabel}</div>
      </div>
      <div class="player-tab-score">${p.score ?? 0}</div>
    `;
    strip.appendChild(card);
  });
}

function subscribeRealtime(roomId) {
  if (state.channel) supabase.removeChannel(state.channel);

  state.channel = supabase
    .channel(`room-${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      async (payload) => {
        const previousStatus = state.room?.status;
        const previousRound = state.room?.round;
        state.room = payload.new;

        // During writing, only rerender when the actual round/status changes.
        // This prevents realtime events from wiping text the player is typing.
        if (state.room.status === "writing" && previousStatus === "writing" && previousRound === state.room.round) {
          return;
        }

        renderForStatus();
        await renderPlayerStrip();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
      async () => {
        await refreshPlayers();
        await renderPlayerStrip();

        // Player joins/leaves/score changes should never rebuild the writing form.
        if (state.room?.status === "writing") {
          return;
        }

        renderForStatus();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "papers", filter: `room_id=eq.${roomId}` },
      async () => {
        if (state.room?.status === "writing") {
          await renderPlayerStrip();
          await maybeAutoAdvanceWriting();
        }
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `room_id=eq.${roomId}` },
      async () => {
        if (state.room?.status === "guessing") {
          await renderGuessing();
          await maybeAutoAdvanceGuessing();
        }
      })
    .subscribe();
}

function isHost() {
  const me = state.players.find((p) => p.id === state.playerId);
  return !!me?.is_host;
}

// ---------------------------------------------------------------------
// dispatch UI based on room status
// ---------------------------------------------------------------------
function renderForStatus() {
  if (!state.room) return;
  switch (state.room.status) {
    case "lobby": renderLobby(); showScreen("lobby"); break;
    case "writing": renderWriting(); showScreen("writing"); break;
    case "guessing": renderGuessing(); showScreen("guessing"); break;
    case "reveal": renderReveal(); showScreen("reveal"); break;
    default: break; // short in-between statuses: stay on the current screen
  }
}

// ---------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------
function renderLobby() {
  $("lobby-code").textContent = state.room.code;
  const list = $("lobby-players");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `${avatarMarkup(p.avatar, "avatar-svg lobby-avatar")} ${escapeHtml(p.name)}` +
      (p.is_host ? `<span class="host-tag">HOST</span>` : "");
    list.appendChild(li);
  });

  const host = isHost();
  $("lobby-host-controls").classList.toggle("hidden", !host);
  const countLabel = `${state.players.length}/${MAX_PLAYERS} players`;
  $("lobby-hint").textContent = host
    ? (state.players.length < 3 ? `Need at least 3 players to start. (${countLabel})` : countLabel)
    : `Waiting for the host to start the game… (${countLabel})`;
  $("btn-start").disabled = state.players.length < 3;

  // Extempore mode controls (host) + note (everyone)
  const extempore = !!state.room.extempore;
  $("toggle-extempore").checked = extempore;
  $("extempore-options").classList.toggle("hidden", !(host && extempore));
  $("lobby-mode-note").textContent = extempore
    ? "🎤 Extempore mode: everyone writes on the same topic each round."
    : "";

  const topicList = $("custom-topic-list");
  topicList.innerHTML = "";
  (state.room.custom_topics || []).forEach((topic, index) => {
    const li = document.createElement("li");
    li.className = "topic-chip";
    li.innerHTML = `<span>${escapeHtml(topic)}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", `Remove topic ${topic}`);
    remove.onclick = () => removeCustomTopic(index);
    li.appendChild(remove);
    topicList.appendChild(li);
  });
}

// ---------------------------------------------------------------------
// EXTEMPORE MODE (host picks it in the lobby)
// ---------------------------------------------------------------------
async function toggleExtempore() {
  const on = $("toggle-extempore").checked;
  const { error } = await supabase.from("rooms").update({ extempore: on }).eq("id", state.room.id);
  if (error) {
    $("toggle-extempore").checked = !on;
    alert("Could not change Extempore mode: " + error.message);
  }
}

async function addCustomTopic() {
  const input = $("input-topic");
  const text = input.value.trim().replace(/\s+/g, " ");
  if (!text) return;

  const list = state.room.custom_topics || [];
  if (list.length >= MAX_CUSTOM_TOPICS) return setError("topic-error", `Up to ${MAX_CUSTOM_TOPICS} custom topics.`);
  if (list.some((t) => t.toLowerCase() === text.toLowerCase())) return setError("topic-error", "You already added that one.");

  const next = [...list, text];
  input.value = "";
  state.room.custom_topics = next;
  renderLobby();
  const { error } = await supabase.from("rooms").update({ custom_topics: next }).eq("id", state.room.id);
  if (error) setError("topic-error", error.message);
}

async function removeCustomTopic(index) {
  const next = (state.room.custom_topics || []).filter((_, i) => i !== index);
  state.room.custom_topics = next;
  renderLobby();
  const { error } = await supabase.from("rooms").update({ custom_topics: next }).eq("id", state.room.id);
  if (error) setError("topic-error", error.message);
}

// Custom topics are used first (random order), then the built-in fun ones.
// Nothing repeats until every topic has been used once.
function pickTopic(room) {
  const custom = room.custom_topics || [];
  let used = room.used_topics || [];
  const unused = (list) => list.filter((t) => !used.includes(t));

  let pool = unused(custom);
  if (pool.length === 0) pool = unused(BUILT_IN_TOPICS);
  if (pool.length === 0) {
    used = [];
    pool = custom.length ? custom : BUILT_IN_TOPICS;
  }
  const topic = pool[Math.floor(Math.random() * pool.length)];
  return { topic, used: [...used, topic] };
}

// shows "Topic: ..." on the guessing / results screens (only in Extempore mode)
function renderTopicLine(id) {
  const el = $(id);
  if (!el) return;
  const topic = state.room?.extempore ? state.room.topic : null;
  el.textContent = topic ? `Topic: ${topic}` : "";
  el.classList.toggle("hidden", !topic);
}

async function startGame() {
  const seconds = parseInt($("select-seconds").value, 10);
  const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
  const update = {
    status: "writing",
    round: 1,
    round_seconds: seconds,
    writing_ends_at: endsAt,
  };
  if (state.room.extempore) {
    const { topic, used } = pickTopic({ ...state.room, used_topics: [] });
    update.topic = topic;
    update.used_topics = used;
  }
  const { error } = await supabase.from("rooms").update(update)
    .eq("id", state.room.id).eq("status", "lobby");
  if (error) alert("Could not start the game: " + error.message);
}

// ---------------------------------------------------------------------
// WRITING
// ---------------------------------------------------------------------
function renderWriting() {
  $("write-round").textContent = state.room.round;

  // Extempore mode: show the topic everyone is writing about
  const topic = state.room.extempore ? state.room.topic : null;
  $("write-topic").classList.toggle("hidden", !topic);
  $("write-topic-text").textContent = topic || "";
  $("write-text").placeholder = topic
    ? "Write about the topic above — make it good, funny or weird. Someone will have to guess it's you."
    : "Write anything — a confession, a lie, a weird fact. Someone will have to guess it's you.";

  // Only initialize the writing form once per round.
  // Realtime player updates must NEVER erase text currently being typed.
  if (state.currentWritingRound === state.room.round) return;

  state.currentWritingRound = state.room.round;
  $("write-text").value = "";
  $("write-text").disabled = false;
  $("btn-submit-paper").disabled = false;
  $("write-status").textContent = "";
  startCountdown(state.room.writing_ends_at);
}

function startCountdown(endsAtISO) {
  clearInterval(state.timerHandle);
  const endsAt = new Date(endsAtISO).getTime();
  const tick = () => {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const el = $("write-timer");
    el.textContent = remaining;
    el.classList.toggle("low", remaining <= 10);
    if (remaining <= 0) {
      clearInterval(state.timerHandle);
      $("write-text").disabled = true;
      $("btn-submit-paper").disabled = true;
      $("write-status").textContent = "Time's up — shuffling papers…";
      if (isHost()) claimAndDistribute();
    }
  };
  tick();
  state.timerHandle = setInterval(tick, 250);
}

async function submitPaper() {
  const content = $("write-text").value.trim();
  if (!content) return;
  $("btn-submit-paper").disabled = true;
  const { error } = await supabase.from("papers").insert({
    room_id: state.room.id,
    round: state.room.round,
    author_id: state.playerId,
    content,
  });
  if (error) {
    // likely already submitted (unique constraint) — that's fine
    $("write-status").textContent = "Submitted. Waiting for others…";
  } else {
    $("write-status").textContent = "Submitted. Waiting for others…";
    $("write-text").disabled = true;
  }
  await renderPlayerStrip();
  await maybeAutoAdvanceWriting();
}

// if everyone has submitted early, don't make people wait for the clock
async function maybeAutoAdvanceWriting() {
  if (state.room.status !== "writing") return;
  const { data: papers } = await supabase
    .from("papers").select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
  if ((papers?.length || 0) >= state.players.length && isHost()) {
    claimAndDistribute();
  }
}

// ---------------------------------------------------------------------
// SHUFFLE + DISTRIBUTE (race-safe: only the client that wins the
// conditional status update actually does the work)
// ---------------------------------------------------------------------
async function claimAndDistribute() {
  const { data: claimed } = await supabase
    .from("rooms")
    .update({ status: "distributing" })
    .eq("id", state.room.id)
    .eq("status", "writing")
    .select();
  if (!claimed || claimed.length === 0) return; // someone else already claimed it

  await backfillMissingPapers();
  const made = await assignPapers();

  // if there was nothing to guess (nobody wrote anything), skip straight to results
  await supabase.from("rooms").update({ status: made > 0 ? "guessing" : "reveal" }).eq("id", state.room.id);
}

async function backfillMissingPapers() {
  const { data: papers } = await supabase
    .from("papers").select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
  const wrote = new Set((papers || []).map((p) => p.author_id));
  const missing = state.players.filter((p) => !wrote.has(p.id));
  if (missing.length === 0) return;

  await supabase.from("papers").insert(
    missing.map((p) => ({
      room_id: state.room.id,
      round: state.room.round,
      author_id: p.id,
      content: "🤷 (didn't write anything in time)",
      auto_filled: true,
    }))
  );
}

// Every player gets EVERY paper except their own.
// One assignment row = one (paper, guesser) pair, so with n players there
// are n x (n-1) rows. Papers nobody really wrote (auto-filled) are skipped.
async function assignPapers() {
  await refreshPlayers();
  const { data: papers } = await supabase
    .from("papers").select().eq("room_id", state.room.id).eq("round", state.room.round);

  const realPapers = (papers || []).filter((p) => !p.auto_filled);
  const rows = [];
  realPapers.forEach((paper) => {
    state.players.forEach((player) => {
      if (player.id === paper.author_id) return; // never guess your own paper
      rows.push({
        room_id: state.room.id,
        round: state.room.round,
        paper_id: paper.id,
        assigned_to: player.id,
      });
    });
  });

  if (rows.length > 0) {
    const { error } = await supabase.from("assignments").insert(rows);
    if (error) {
      console.error("Could not create assignments:", error);
      alert("Could not deal the papers: " + error.message);
      return 0;
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------
// GUESSING  (one paper at a time, until every other paper has a guess)
// ---------------------------------------------------------------------
async function renderGuessing() {
  const seq = ++state.guessRenderSeq;
  renderTopicLine("guess-topic");
  await renderPlayerStrip();

  const { data } = await supabase
    .from("assignments").select("id, guessed_player_id, papers(content)")
    .eq("room_id", state.room.id).eq("round", state.room.round).eq("assigned_to", state.playerId)
    .order("id");
  if (seq !== state.guessRenderSeq) return; // a newer render took over

  const mine = data || [];
  const total = mine.length;
  const answered = mine.filter((a) => a.guessed_player_id !== null).length;
  const current = mine.find((a) => a.guessed_player_id === null);

  const grid = $("guess-player-grid");
  grid.innerHTML = "";

  if (total === 0) {
    $("guess-progress").textContent = "";
    $("guess-paper-text").textContent = "There's nothing for you to guess this round.";
    $("guess-status").textContent = "Waiting for everyone else…";
    return;
  }

  if (!current) {
    $("guess-progress").textContent = `${total} of ${total} guessed`;
    $("guess-paper-text").textContent = "All your guesses are locked in. 🔒";
    $("guess-status").textContent = "Waiting for everyone else…";
    return;
  }

  $("guess-progress").textContent = `Paper ${answered + 1} of ${total}`;
  $("guess-paper-text").textContent = current.papers.content;
  $("guess-status").textContent = "Who wrote this paper? Tap a player.";

  state.players
    .filter((p) => p.id !== state.playerId)
    .forEach((p) => {
      const card = document.createElement("div");
      card.className = "player-card";
      card.innerHTML = `${avatarMarkup(p.avatar, "avatar-svg guess-avatar")} ${escapeHtml(p.name)}`;
      card.onclick = () => submitGuess(current.id, p.id);
      grid.appendChild(card);
    });
}

async function submitGuess(assignmentId, guessedPlayerId) {
  if (state.submittingGuess) return;
  state.submittingGuess = true;
  try {
    await supabase
      .from("assignments")
      .update({ guessed_player_id: guessedPlayerId })
      .eq("id", assignmentId)
      .is("guessed_player_id", null); // only the first click sticks
    await renderGuessing(); // move on to my next paper right away
    await maybeAutoAdvanceGuessing();
  } finally {
    state.submittingGuess = false;
  }
}

async function maybeAutoAdvanceGuessing() {
  if (state.room?.status !== "guessing") return;
  const { data: assignments } = await supabase
    .from("assignments").select("guessed_player_id")
    .eq("room_id", state.room.id).eq("round", state.room.round);
  const allGuessed = (assignments || []).length > 0 &&
    assignments.every((a) => a.guessed_player_id !== null);
  if (allGuessed) claimAndReveal();
}

// ---------------------------------------------------------------------
// REVEAL + scoring (also race-safe via conditional status update)
// 1 point for every correct guess.
// ---------------------------------------------------------------------
async function claimAndReveal() {
  const { data: claimed } = await supabase
    .from("rooms")
    .update({ status: "scoring" })
    .eq("id", state.room.id)
    .eq("status", "guessing")
    .select();
  if (!claimed || claimed.length === 0) return;

  await refreshPlayers(); // make sure we add to the latest scores

  const { data: assignments } = await supabase
    .from("assignments").select("assigned_to, guessed_player_id, papers(author_id)")
    .eq("room_id", state.room.id).eq("round", state.room.round);

  // add up correct guesses per player first, then update each player ONCE
  const gained = {};
  (assignments || []).forEach((a) => {
    if (a.guessed_player_id === a.papers.author_id) {
      gained[a.assigned_to] = (gained[a.assigned_to] || 0) + 1;
    }
  });

  for (const [playerId, points] of Object.entries(gained)) {
    const player = state.players.find((p) => p.id === playerId);
    await supabase.from("players").update({ score: (player?.score || 0) + points }).eq("id", playerId);
  }

  await supabase.from("rooms").update({ status: "reveal" }).eq("id", state.room.id);
}

async function renderReveal() {
  await refreshPlayers();
  await renderPlayerStrip();
  $("reveal-round").textContent = state.room.round;
  renderTopicLine("reveal-topic");

  const { data: assignments } = await supabase
    .from("assignments").select("paper_id, assigned_to, guessed_player_id, papers(content, author_id)")
    .eq("room_id", state.room.id).eq("round", state.room.round);

  const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));

  // group guesses by paper, and count each player's correct guesses this round
  const papers = new Map();
  const roundPoints = {};
  (assignments || []).forEach((a) => {
    if (!papers.has(a.paper_id)) papers.set(a.paper_id, { paper: a.papers, guesses: [] });
    papers.get(a.paper_id).guesses.push(a);
    if (a.guessed_player_id === a.papers.author_id) {
      roundPoints[a.assigned_to] = (roundPoints[a.assigned_to] || 0) + 1;
    }
  });

  const orderOf = (authorId) => state.players.findIndex((p) => p.id === authorId);
  const groups = [...papers.values()].sort((x, y) => orderOf(x.paper.author_id) - orderOf(y.paper.author_id));

  // new round of results -> start from the first paper
  if (state.revealRound !== state.room.round) {
    state.revealRound = state.room.round;
    state.revealIndex = 0;
  }

  state.revealCards = groups.map(({ paper, guesses }) => {
    const author = byId[paper.author_id];
    const lines = guesses.map((a) => {
      const guesser = byId[a.assigned_to];
      const guessed = byId[a.guessed_player_id];
      const correct = a.guessed_player_id === paper.author_id;
      return `<div class="guess-line">${avatarMarkup(guesser?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(guesser?.name || "Unknown")} guessed <strong>${avatarMarkup(guessed?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(guessed?.name || "—")}</strong>
        — <span class="verdict ${correct ? "correct" : "wrong"}">${correct ? "correct!" : "wrong"}</span></div>`;
    }).join("");

    return `<div class="reveal-item">
      <div class="content">"${escapeHtml(paper.content)}"</div>
      <div>Written by <strong>${avatarMarkup(author?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(author?.name || "Unknown")}</strong></div>
      ${lines}
    </div>`;
  });
  showRevealPaper();

  const board = $("scoreboard");
  board.innerHTML = "<strong>Scoreboard</strong>";
  [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0)).forEach((p) => {
    const gain = roundPoints[p.id] || 0;
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `<span>${avatarMarkup(p.avatar, "avatar-svg inline-avatar")} ${escapeHtml(p.name)}</span>
      <span>${gain ? `<span class="round-gain">+${gain}</span> ` : ""}${p.score || 0}</span>`;
    board.appendChild(row);
  });

  const host = isHost();
  $("reveal-host-controls").classList.toggle("hidden", !host);
  $("reveal-hint").textContent = host ? "" : "Waiting for the host to start the next round…";
}

// Shows ONE paper's results at a time; the arrows switch between papers.
function showRevealPaper(animate = false) {
  const total = state.revealCards.length;
  const list = $("reveal-list");
  const prev = $("reveal-prev");
  const next = $("reveal-next");

  if (total === 0) {
    list.innerHTML = `<div class="reveal-item">Nobody wrote anything this round.</div>`;
    $("reveal-counter").textContent = "";
    prev.classList.add("hidden");
    next.classList.add("hidden");
    return;
  }

  state.revealIndex = Math.min(Math.max(state.revealIndex, 0), total - 1);
  list.innerHTML = state.revealCards[state.revealIndex];
  if (animate) {
    list.classList.remove("swap");
    void list.offsetWidth;
    list.classList.add("swap");
  }

  $("reveal-counter").textContent = `Paper ${state.revealIndex + 1} of ${total}`;
  prev.classList.remove("hidden");
  next.classList.remove("hidden");
  prev.disabled = state.revealIndex === 0;
  next.disabled = state.revealIndex === total - 1;
}

function moveReveal(direction) {
  state.revealIndex += direction;
  showRevealPaper(true);
}

async function nextRound() {
  state.currentWritingRound = null;
  const seconds = state.room.round_seconds;
  const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
  const update = {
    status: "writing",
    round: state.room.round + 1,
    writing_ends_at: endsAt,
  };
  if (state.room.extempore) {
    const { topic, used } = pickTopic(state.room);
    update.topic = topic;
    update.used_topics = used;
  }
  const { error } = await supabase.from("rooms").update(update)
    .eq("id", state.room.id).eq("status", "reveal");
  if (error) alert("Could not start the next round: " + error.message);
}

// ---------------------------------------------------------------------
// wire up events
// ---------------------------------------------------------------------
renderAvatarPicker();

$("avatar-prev").onclick = () => changeAvatar(-1);
$("avatar-next").onclick = () => changeAvatar(1);
$("btn-continue").onclick = continueFromName;
$("btn-back-name").onclick = backToName;

$("btn-create").onclick = createRoom;
$("btn-join").onclick = joinRoom;
$("btn-start").onclick = startGame;
$("btn-submit-paper").onclick = submitPaper;
$("btn-next-round").onclick = nextRound;
$("btn-leave").onclick = leaveRoom;
$("toggle-extempore").onchange = toggleExtempore;
$("btn-add-topic").onclick = addCustomTopic;
$("input-topic").addEventListener("keydown", (event) => {
  if (event.key === "Enter") addCustomTopic();
});
$("reveal-prev").onclick = () => moveReveal(-1);
$("reveal-next").onclick = () => moveReveal(1);

// left/right arrow keys also flip through the results
document.addEventListener("keydown", (event) => {
  if (!$("screen-reveal").classList.contains("active")) return;
  if (event.key === "ArrowLeft" && !$("reveal-prev").disabled) moveReveal(-1);
  if (event.key === "ArrowRight" && !$("reveal-next").disabled) moveReveal(1);
});

$("input-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") continueFromName();
});

$("input-code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});

// Always start on the name screen when the website opens.
clearSession();
$("room-bar").classList.add("hidden");
showScreen("name");
