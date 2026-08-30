import { GAME_PHASE } from "./config.js";
import {
  createGameState,
  useSelectedCards,
  discardEntireHand,
  banishCardFromDiscard,
  startBonusTurn,
  bonusHit,
  bonusStand,
  checkWinner,
  isMarketExhausted,
  runMarketAndRefill,
  endTurn,
} from "./gameLogic.js";
import * as AI from "./ai.js";
import { render, renderOnlineScreen } from "./ui.js";
import {
  createRoom,
  joinRoom,
  tryRejoin,
  loadRejoin,
  clearRejoin,
  subscribeRoom,
  subscribeIntents,
  sendIntent,
  setupPresence,
  writeState,
  redactStateForPlayer,
  hydrateNetworkState,
} from "./net.js";

const HUMAN_PLAYER_ID = "P1";
const AI_PLAYER_ID = "P2";
const AI_STEP_DELAY = 550;
const TOAST_DURATION = 4500;

// Game-mutating actions that a networked guest is never allowed to apply
// locally — instead of running the gameLogic mutator, the guest sends the
// action as an intent to the host, and only updates its own screen once the
// host's redacted rebroadcast arrives. Everything NOT in this set (card
// selection preview, opening a pile modal, setup toggles, ...) is purely
// per-client UI and is always handled locally regardless of role.
const NETWORKED_ACTIONS = new Set([
  "use-cards",
  "discard-hand",
  "pick-market",
  "bonus-hit",
  "bonus-stand",
  "banish-card",
  "skip-banish",
]);

const root = document.getElementById("app-root");

let settings = {
  hideOpponentBoard: false,
  requiredLines: 3,
  mode: "pvp",
  rewardBanishCard: true,
  rewardExtraTurn: true,
  rewardDiscardCorrection: true,
};
let state = null;
let ui = { selectedCardIds: [], view: "setup", toast: null, pileModal: null, lastTurnSummary: null, online: freshOnlineUi() };

let lastScrollKey = null;
let toastTimer = null;

// ---------------------------------------------------------------------------
// Online (Firebase RTDB) connection state — kept OUTSIDE `state`/`ui` on
// purpose: it's per-browser connection/session bookkeeping (room code,
// subscriptions, host-authority seq counter), not game data. It is never
// itself sent over the network or persisted; the host's actual game state
// lives in `state`, and only redacted views of that are broadcast (see
// net.js redactStateForPlayer / writeState).
// ---------------------------------------------------------------------------
let net = {
  role: null, // "host" | "guest"
  roomCode: null,
  myPlayerId: null, // "P1" | "P2"
  players: {},
  seq: 0,
  lastSyncedJson: null,
  writeInFlight: false,
  pendingResync: false,
  unsubRoom: null,
  unsubIntents: null,
};

function freshOnlineUi() {
  return { step: "menu", error: null, nameInput: "", joinCodeInput: "" };
}

function cleanupNet() {
  if (net.unsubRoom) net.unsubRoom();
  if (net.unsubIntents) net.unsubIntents();
  net = {
    role: null,
    roomCode: null,
    myPlayerId: null,
    players: {},
    seq: 0,
    lastSyncedJson: null,
    writeInFlight: false,
    pendingResync: false,
    unsubRoom: null,
    unsubIntents: null,
  };
}

function startNetSubscriptions() {
  if (net.unsubRoom) net.unsubRoom();
  if (net.unsubIntents) net.unsubIntents();
  net.unsubRoom = subscribeRoom(net.roomCode, onRoomSnapshot);
  setupPresence(net.roomCode, net.myPlayerId);
  if (net.role === "host") {
    net.unsubIntents = subscribeIntents(net.roomCode, onHostIntent);
  }
}

/** Fires on every room change for both host and guest. */
function onRoomSnapshot(room) {
  if (!room) return;
  net.players = room.players || {};

  if (net.role === "host") {
    // The host's `state` is the sole source of truth and is never replaced
    // from the network — this subscription only feeds the lobby UI (seeing
    // the guest join/leave) while we're still on the online-lobby screen.
    if (ui.view === "online") doRender();
    return;
  }

  // Guest: once the host has started the game, our own screen is driven
  // entirely by the redacted view the host broadcasts for us.
  if (room.phase === "playing" && room.views && room.views[net.myPlayerId]) {
    state = hydrateNetworkState(room.views[net.myPlayerId]);
    if (ui.view !== "game") {
      ui = { selectedCardIds: [], view: "game", toast: null, pileModal: null, lastTurnSummary: null, online: ui.online };
      lastScrollKey = null;
    }
    doRender();
  } else if (ui.view === "online") {
    ui.online.step = "guest-waiting";
    doRender();
  }
}

/** Host-only: apply a guest's action intent through the exact same code
 * path a local click would use, then let doRender()'s sync step rebroadcast. */
function onHostIntent(intent) {
  if (!state || net.role !== "host" || !intent) return;
  const { playerId, action, cardId, selectedCardIds } = intent;

  if (action === "restart-game") {
    if (state.phase === GAME_PHASE.GAME_OVER) startNewGame();
    return;
  }

  const isBanishAction = action === "banish-card" || action === "skip-banish";
  if (isBanishAction) {
    if (!state.banishPrompt || state.banishPrompt.playerId !== playerId) return; // not their turn to choose
  } else if (playerId !== state.currentPlayerId) {
    return; // stale/out-of-turn intent — ignore
  }

  const target = { dataset: { cardId: cardId || "" } };
  handleAction(action, target, { selectedCardIds });
}

/**
 * Host-only: push the latest true state to RTDB as two redacted views.
 * Writes are serialized (never two in flight at once) — if a change comes in
 * while a write is still round-tripping, we just remember to resync once it
 * settles, using whatever `state` looks like *then*. This also means a
 * seq-conflict or network failure can't silently strand a guest's view: we
 * treat `net.lastSyncedJson` as "confirmed synced" only once writeState()
 * actually reports success, and otherwise immediately retry.
 */
function syncHostState() {
  if (settings.mode !== "online" || net.role !== "host" || !state || !net.roomCode) return;
  const json = JSON.stringify(state);
  if (json === net.lastSyncedJson) return; // nothing actually changed since the last confirmed write
  if (net.writeInFlight) {
    net.pendingResync = true;
    return;
  }

  net.writeInFlight = true;
  const roomCode = net.roomCode;
  writeState(roomCode, net.seq, state)
    .then(({ committed, seq }) => {
      if (committed) {
        net.seq = seq;
        net.lastSyncedJson = json;
      } else {
        // Someone else's write landed first (e.g. a stale duplicate host
        // tab) — adopt the server's actual seq and retry against that.
        console.warn("[net] writeState conflict (seq mismatch) — resyncing at seq", seq);
        net.seq = seq;
        net.pendingResync = true;
      }
    })
    .catch((err) => {
      console.error("[net] writeState failed", err);
      net.pendingResync = true;
    })
    .finally(() => {
      net.writeInFlight = false;
      if (net.pendingResync && net.roomCode === roomCode) {
        net.pendingResync = false;
        syncHostState();
      }
    });
}

/** What to actually hand to render(): host and guest both see only their
 * own redacted view, regardless of which side is holding the true state. */
function displayState() {
  if (!state) return null;
  if (settings.mode === "online" && net.myPlayerId) {
    return redactStateForPlayer(state, net.myPlayerId);
  }
  return state;
}

function doRender() {
  if (ui.view === "online") {
    root.innerHTML = "";
    root.appendChild(
      renderOnlineScreen({
        step: ui.online.step,
        roomCode: net.roomCode,
        myPlayerId: net.myPlayerId,
        players: net.players,
        error: ui.online.error,
        nameInput: ui.online.nameInput,
        joinCodeInput: ui.online.joinCodeInput,
        hasRejoinInfo: Boolean(loadRejoin()),
      })
    );
    return;
  }

  const perspectiveIdOverride = settings.mode === "online" ? net.myPlayerId : undefined;
  render(displayState(), ui, settings, root, perspectiveIdOverride);
  maybeAutoScroll();
  syncHostState();
}

function maybeAutoScroll() {
  if (!state || ui.view !== "game") return;
  const perspectiveId =
    settings.mode === "ai" ? HUMAN_PLAYER_ID : settings.mode === "online" ? net.myPlayerId : state.currentPlayerId;
  const isMyTurn = state.currentPlayerId === perspectiveId;
  if (!isMyTurn) {
    lastScrollKey = null;
    return;
  }

  const key = `${state.currentPlayerId}:${state.phase}`;
  if (key === lastScrollKey) return;
  lastScrollKey = key;

  let targetId = null;
  if (state.phase === GAME_PHASE.MAIN_ACTION) targetId = "hand-section";
  else if (state.phase === GAME_PHASE.BONUS_DRAW) targetId = "bonus-section";
  else if (state.phase === GAME_PHASE.MARKET_PICK) targetId = "market-section";

  if (targetId) {
    const target = document.getElementById(targetId);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function showToast(title, lines) {
  ui.toast = { title, lines: lines.length > 0 ? lines : ["(특별한 행동 없음)"] };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast = null;
    doRender();
  }, TOAST_DURATION);
}

/** Turn raw log lines from one turn into short tags, e.g. "호명 (14)", "내 빙고판 취소!". */
function summarizeTurnLogCompact(lines, viewerName) {
  const tags = [];
  let m;
  for (const line of lines) {
    if ((m = line.match(/이\(가\) .+를 사용해 (\d+)을\(를\) 호명했습니다\.$/))) {
      tags.push(`호명 (${m[1]})`);
    } else if (line.match(/이\(가\) 손패를 전부 버렸습니다\.$/)) {
      tags.push("버리기");
    } else if ((m = line.match(/은\(는\) (\d+)을\(를\) 체크했습니다\.$/))) {
      tags.push(`보너스호명 (${m[1]})`);
    } else if (line.match(/이\(가\) \d+으로 버스트했습니다!$/)) {
      tags.push("버스트");
    } else if ((m = line.match(/^(.+)의 (\d+) 체크가 취소되었습니다\.$/))) {
      tags.push(m[1] === viewerName ? "내 빙고판 취소!" : `${m[1]} 취소`);
    } else if ((m = line.match(/이\(가\) 시장에서 (\d+)을\(를\) 가져갔습니다\.$/))) {
      tags.push(`시장 (${m[1]})`);
    } else if ((m = line.match(/이\(가\) 버린 카드 더미에서 (\d+)을\(를\) 완전히 제거했습니다\.$/))) {
      tags.push(`카드 폐기 (${m[1]})`);
    } else if (line.match(/한 줄 완성 보상으로 한 턴을 더 진행합니다!$/)) {
      tags.push("한 턴 더!");
    } else if (line.match(/연속 버리기 보정으로 카드를 1장 더 뽑습니다\.$/)) {
      tags.push("보정 드로우");
    }
    // everything else (per-hit reveals, reshuffles, bonus-start, deck-exhausted notes) is dropped to stay concise
  }
  return tags;
}

function schedule(fn) {
  setTimeout(fn, AI_STEP_DELAY);
}

function isAiTurn() {
  return settings.mode === "ai" && state.currentPlayerId === AI_PLAYER_ID;
}

function startNewGame() {
  state = createGameState({
    requiredLines: settings.requiredLines,
    p2Name: settings.mode === "ai" ? "AI" : net.players.P2 ? net.players.P2.name : "Player 2",
  });
  ui = { selectedCardIds: [], view: "game", toast: null, pileModal: null, lastTurnSummary: null, online: ui.online };
  lastScrollKey = null;
  clearTimeout(toastTimer);
  doRender();
}

/** Queue line-completion rewards earned by actorId for `gained` newly completed lines. */
function queueLineRewards(actorId, gained) {
  if (settings.rewardExtraTurn) {
    state.extraTurnCredits[actorId] = (state.extraTurnCredits[actorId] || 0) + gained;
  }
  if (settings.rewardBanishCard) {
    state.pendingBanish[actorId] = (state.pendingBanish[actorId] || 0) + gained;
  }
}

/** Entry point after a turn's line-changing action (call/bonus) has fully resolved. */
function goToMarketPick(usedCardsThisTurn) {
  const actorId = state.currentPlayerId;

  const gained = state.players[actorId].bingoCount - state.linesBeforeCurrentAction;
  if (gained > 0) queueLineRewards(actorId, gained);

  state.currentTurnExtraHandCards = 0;
  if (usedCardsThisTurn && settings.rewardDiscardCorrection && state.players[actorId].bonusDrawReady) {
    state.currentTurnExtraHandCards = 1;
    state.players[actorId].bonusDrawReady = false;
    state.log.push(`${state.players[actorId].name}이(가) 연속 버리기 보정으로 카드를 1장 더 뽑습니다.`);
  }

  proceedPastBanish();
}

function proceedPastBanish() {
  const actorId = state.currentPlayerId;

  if (settings.rewardBanishCard && (state.pendingBanish[actorId] || 0) > 0) {
    const player = state.players[actorId];
    if (player.discardPile.length === 0) {
      state.pendingBanish[actorId] = 0;
    } else if (settings.mode === "ai" && actorId === AI_PLAYER_ID) {
      const cardId = AI.chooseCardToBanish(state, actorId);
      if (cardId) banishCardFromDiscard(state, actorId, cardId);
      state.pendingBanish[actorId] -= 1;
      doRender();
      schedule(proceedPastBanish);
      return;
    } else {
      state.banishPrompt = { playerId: actorId };
      doRender();
      return;
    }
  }

  continueToMarketPick();
}

function continueToMarketPick() {
  const actorId = state.currentPlayerId;
  state.phase = GAME_PHASE.MARKET_PICK;

  if (isMarketExhausted(state)) {
    runMarketAndRefill(state, actorId, null, state.currentTurnExtraHandCards);
    completeTurn();
    return;
  }

  if (isAiTurn()) {
    doRender();
    schedule(() => {
      const cardId = AI.chooseMarketCard(state, actorId);
      runMarketAndRefill(state, actorId, cardId, state.currentTurnExtraHandCards);
      completeTurn();
    });
  } else {
    doRender();
  }
}

function completeTurn() {
  const finishedPlayerId = state.currentPlayerId;

  if ((state.extraTurnCredits[finishedPlayerId] || 0) > 0) {
    state.extraTurnCredits[finishedPlayerId] -= 1;
    state.log.push(`${state.players[finishedPlayerId].name}이(가) 한 줄 완성 보상으로 한 턴을 더 진행합니다!`);
    ui.selectedCardIds = [];
    ui.pileModal = null;
    state.phase = GAME_PHASE.MAIN_ACTION;
    state.linesBeforeCurrentAction = state.players[finishedPlayerId].bingoCount;

    if (isAiTurn()) {
      doRender();
      schedule(runAiMainAction);
    } else {
      ui.view = "game";
      doRender();
    }
    return;
  }

  const rawTurnLines = state.log.slice(state.turnLogStart);
  endTurn(state);
  state.turnLogStart = state.log.length;
  state.linesBeforeCurrentAction = state.players[state.currentPlayerId].bingoCount;
  ui.selectedCardIds = [];
  ui.pileModal = null;

  if (isAiTurn()) {
    ui.view = "game";
    doRender();
    schedule(runAiMainAction);
    return;
  }

  // state.currentPlayerId is now the incoming player: the one who will see this summary.
  const viewerName = state.players[state.currentPlayerId].name;
  const tags = summarizeTurnLogCompact(rawTurnLines, viewerName);

  if (settings.mode === "ai" && finishedPlayerId === AI_PLAYER_ID) {
    showToast(`${state.players[AI_PLAYER_ID].name}의 턴`, tags);
  }
  if (settings.mode === "pvp") {
    ui.lastTurnSummary = { playerName: state.players[finishedPlayerId].name, lines: tags };
  }

  // Online play: each side has its own device/screen, so there is no
  // "pass the device" overlay — just stay on the game view (buttons
  // naturally disable themselves while it isn't this client's turn).
  ui.view = settings.mode === "ai" || settings.mode === "online" ? "game" : "pass";
  doRender();
}

function afterMainActionResolved(result) {
  ui.selectedCardIds = [];
  const winner = checkWinner(state, state.currentPlayerId);
  if (winner) {
    doRender();
    return;
  }

  if (result.usedAllThreeCards) {
    startBonusTurn(state, state.currentPlayerId);
    if (state.bonusTurn.active) {
      doRender();
      if (isAiTurn()) schedule(aiBonusStep);
    } else {
      afterBonusTurnEnds();
    }
  } else {
    goToMarketPick(true);
  }
}

function afterBonusTurnEnds() {
  const winner = checkWinner(state, state.currentPlayerId);
  doRender();
  if (winner) return;
  goToMarketPick(true);
}

function aiBonusStep() {
  const action = AI.decideBonusAction(state);
  if (action === "stand") {
    bonusStand(state);
  } else {
    bonusHit(state);
  }

  if (state.bonusTurn.active) {
    doRender();
    schedule(aiBonusStep);
  } else {
    afterBonusTurnEnds();
  }
}

function runAiMainAction() {
  const pid = state.currentPlayerId;
  const decision = AI.chooseMainAction(state, pid);

  if (decision.type === "discard") {
    discardEntireHand(state, pid);
    doRender();
    schedule(() => goToMarketPick(false));
    return;
  }

  const result = useSelectedCards(state, pid, decision.cardIds);
  if (!result.ok) {
    discardEntireHand(state, pid);
    doRender();
    schedule(() => goToMarketPick(false));
    return;
  }

  doRender();
  schedule(() => afterMainActionResolved(result));
}

/** Guest-only: package a networked action as an intent and send it to the
 * host instead of mutating anything locally. The guest's own screen only
 * updates once the host's redacted rebroadcast arrives via onRoomSnapshot. */
function sendGuestIntent(action, target) {
  if (!net.roomCode || !net.myPlayerId) return;
  const payload = {};
  if (action === "pick-market" || action === "banish-card") {
    payload.cardId = target && target.dataset ? target.dataset.cardId : null;
  }
  if (action === "use-cards") {
    payload.selectedCardIds = ui.selectedCardIds.slice();
    ui.selectedCardIds = []; // optimistic local clear; server view will confirm
  }
  sendIntent(net.roomCode, net.myPlayerId, action, payload).catch((err) =>
    console.error("[net] sendIntent failed", err)
  );
}

function handleAction(action, target, extra = {}) {
  if (settings.mode === "online" && net.role === "guest" && NETWORKED_ACTIONS.has(action)) {
    sendGuestIntent(action, target);
    return;
  }

  switch (action) {
    case "toggle-hide-opponent": {
      settings.hideOpponentBoard = target.checked;
      break;
    }

    case "toggle-reward-banish": {
      settings.rewardBanishCard = target.checked;
      break;
    }

    case "toggle-reward-extra-turn": {
      settings.rewardExtraTurn = target.checked;
      break;
    }

    case "toggle-discard-correction": {
      settings.rewardDiscardCorrection = target.checked;
      break;
    }

    case "set-lines": {
      settings.requiredLines = Number(target.dataset.lines);
      doRender();
      break;
    }

    case "set-mode": {
      settings.mode = target.dataset.mode;
      doRender();
      break;
    }

    case "start-game": {
      if (settings.mode === "online") {
        ui.view = "online";
        ui.online = freshOnlineUi();
        doRender();
      } else {
        startNewGame();
      }
      break;
    }

    case "back-to-setup": {
      cleanupNet();
      state = null;
      ui = { selectedCardIds: [], view: "setup", toast: null, pileModal: null, lastTurnSummary: null, online: freshOnlineUi() };
      lastScrollKey = null;
      clearTimeout(toastTimer);
      doRender();
      break;
    }

    // --- Online lobby -----------------------------------------------------

    case "online-set-name": {
      // Deliberately skip doRender(): re-drawing on every keystroke would
      // wipe and recreate the <input>, losing focus/cursor position. The
      // value is only read when a create/join button is actually clicked.
      ui.online.nameInput = target.value;
      break;
    }

    case "online-set-code": {
      ui.online.joinCodeInput = target.value.toUpperCase();
      break;
    }

    case "online-create": {
      ui.online.error = null;
      createRoom(ui.online.nameInput.trim() || "Player 1")
        .then(({ code, playerId }) => {
          net.role = "host";
          net.roomCode = code;
          net.myPlayerId = playerId;
          net.seq = 0;
          net.lastSyncedJson = null;
          startNetSubscriptions();
          ui.online.step = "host-waiting";
          doRender();
        })
        .catch((err) => {
          ui.online.error = err.message || String(err);
          doRender();
        });
      break;
    }

    case "online-join": {
      const code = (ui.online.joinCodeInput || "").trim().toUpperCase();
      if (!code) {
        ui.online.error = "방 코드를 입력하세요.";
        doRender();
        break;
      }
      ui.online.error = null;
      joinRoom(code, ui.online.nameInput.trim() || "Player 2")
        .then(({ code: joinedCode, playerId }) => {
          net.role = "guest";
          net.roomCode = joinedCode;
          net.myPlayerId = playerId;
          startNetSubscriptions();
          ui.online.step = "guest-waiting";
          doRender();
        })
        .catch((err) => {
          ui.online.error = err.message || String(err);
          doRender();
        });
      break;
    }

    case "online-rejoin": {
      ui.online.error = null;
      tryRejoin()
        .then((info) => {
          if (!info) {
            ui.online.error = "재접속할 방을 찾을 수 없습니다.";
            doRender();
            return;
          }
          net.role = info.playerId === "P1" ? "host" : "guest";
          net.roomCode = info.code;
          net.myPlayerId = info.playerId;
          net.seq = info.room.seq || 0;
          net.lastSyncedJson = null;
          startNetSubscriptions();
          if (net.role === "host") {
            // The host's true in-memory state (real card identities) does not
            // survive a page reload — only the redacted broadcast views do.
            // Practical limitation of the host-authority model: the host must
            // start a fresh game after reconnecting rather than resume mid-hand.
            ui.online.step = "host-waiting";
            ui.online.error = "재접속했습니다. 이전 게임 진행 상태는 복구되지 않으니 새 게임을 시작해주세요.";
          } else {
            ui.online.step = "guest-waiting"; // onRoomSnapshot will flip to "game" if already playing
          }
          doRender();
        })
        .catch((err) => {
          ui.online.error = String(err);
          doRender();
        });
      break;
    }

    case "online-start": {
      if (net.role !== "host" || !net.players.P2) break;
      startNewGame();
      break;
    }

    case "online-leave": {
      cleanupNet();
      clearRejoin();
      ui.view = "online";
      ui.online = freshOnlineUi();
      state = null;
      doRender();
      break;
    }

    case "toggle-card": {
      const id = target.dataset.cardId;
      const idx = ui.selectedCardIds.indexOf(id);
      if (idx === -1) ui.selectedCardIds.push(id);
      else ui.selectedCardIds.splice(idx, 1);
      doRender();
      break;
    }

    case "use-cards": {
      const cardIds = extra.selectedCardIds || ui.selectedCardIds;
      const result = useSelectedCards(state, state.currentPlayerId, cardIds);
      if (!result.ok) {
        doRender();
        break;
      }
      afterMainActionResolved(result);
      break;
    }

    case "discard-hand": {
      discardEntireHand(state, state.currentPlayerId);
      ui.selectedCardIds = [];
      goToMarketPick(false);
      break;
    }

    case "pick-market": {
      runMarketAndRefill(state, state.currentPlayerId, target.dataset.cardId, state.currentTurnExtraHandCards);
      completeTurn();
      break;
    }

    case "bonus-hit": {
      bonusHit(state);
      if (state.bonusTurn.active) {
        doRender();
      } else {
        afterBonusTurnEnds();
      }
      break;
    }

    case "bonus-stand": {
      bonusStand(state);
      afterBonusTurnEnds();
      break;
    }

    case "pass-continue": {
      ui.view = "game";
      doRender();
      break;
    }

    case "show-pile": {
      ui.pileModal = { kind: target.dataset.pile };
      doRender();
      break;
    }

    case "close-pile-modal": {
      ui.pileModal = null;
      doRender();
      break;
    }

    case "banish-card": {
      const actorId = state.banishPrompt.playerId;
      banishCardFromDiscard(state, actorId, target.dataset.cardId);
      state.pendingBanish[actorId] = Math.max(0, (state.pendingBanish[actorId] || 0) - 1);
      state.banishPrompt = null;
      proceedPastBanish();
      break;
    }

    case "skip-banish": {
      const actorId = state.banishPrompt.playerId;
      state.pendingBanish[actorId] = Math.max(0, (state.pendingBanish[actorId] || 0) - 1);
      state.banishPrompt = null;
      proceedPastBanish();
      break;
    }

    case "restart-game": {
      if (settings.mode === "online" && net.role === "guest") {
        sendGuestIntent("restart-game", target);
        break;
      }
      startNewGame();
      break;
    }

    default:
      break;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handleAction(target.dataset.action, target);
});

document.addEventListener("change", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  handleAction(target.dataset.action, target);
});

// Live-typing support for text inputs (room code / nickname) — 'change' alone
// only fires on blur, which feels unresponsive for these fields.
document.addEventListener("input", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.tagName !== "INPUT" || target.type !== "text") return;
  handleAction(target.dataset.action, target);
});

doRender();
