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
import { render } from "./ui.js";

const HUMAN_PLAYER_ID = "P1";
const AI_PLAYER_ID = "P2";
const AI_STEP_DELAY = 550;
const TOAST_DURATION = 4500;

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
let ui = { selectedCardIds: [], view: "setup", toast: null, pileModal: null, banishPrompt: null, lastTurnSummary: null };

let turnLogStart = 0;
let lastScrollKey = null;
let toastTimer = null;
let linesBeforeCurrentAction = 0;
let currentTurnExtraHandCards = 0;
let extraTurnCredits = { P1: 0, P2: 0 };
let pendingBanish = { P1: 0, P2: 0 };

function doRender() {
  render(state, ui, settings, root);
  maybeAutoScroll();
}

function maybeAutoScroll() {
  if (!state || ui.view !== "game") return;
  const perspectiveId = settings.mode === "ai" ? HUMAN_PLAYER_ID : state.currentPlayerId;
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
    p2Name: settings.mode === "ai" ? "AI" : "Player 2",
  });
  ui = { selectedCardIds: [], view: "game", toast: null, pileModal: null, banishPrompt: null, lastTurnSummary: null };
  turnLogStart = 0;
  lastScrollKey = null;
  linesBeforeCurrentAction = 0;
  currentTurnExtraHandCards = 0;
  extraTurnCredits = { P1: 0, P2: 0 };
  pendingBanish = { P1: 0, P2: 0 };
  clearTimeout(toastTimer);
  doRender();
}

/** Queue line-completion rewards earned by actorId for `gained` newly completed lines. */
function queueLineRewards(actorId, gained) {
  if (settings.rewardExtraTurn) {
    extraTurnCredits[actorId] = (extraTurnCredits[actorId] || 0) + gained;
  }
  if (settings.rewardBanishCard) {
    pendingBanish[actorId] = (pendingBanish[actorId] || 0) + gained;
  }
}

/** Entry point after a turn's line-changing action (call/bonus) has fully resolved. */
function goToMarketPick(usedCardsThisTurn) {
  const actorId = state.currentPlayerId;

  const gained = state.players[actorId].bingoCount - linesBeforeCurrentAction;
  if (gained > 0) queueLineRewards(actorId, gained);

  currentTurnExtraHandCards = 0;
  if (usedCardsThisTurn && settings.rewardDiscardCorrection && state.players[actorId].bonusDrawReady) {
    currentTurnExtraHandCards = 1;
    state.players[actorId].bonusDrawReady = false;
    state.log.push(`${state.players[actorId].name}이(가) 연속 버리기 보정으로 카드를 1장 더 뽑습니다.`);
  }

  proceedPastBanish();
}

function proceedPastBanish() {
  const actorId = state.currentPlayerId;

  if (settings.rewardBanishCard && (pendingBanish[actorId] || 0) > 0) {
    const player = state.players[actorId];
    if (player.discardPile.length === 0) {
      pendingBanish[actorId] = 0;
    } else if (settings.mode === "ai" && actorId === AI_PLAYER_ID) {
      const cardId = AI.chooseCardToBanish(state, actorId);
      if (cardId) banishCardFromDiscard(state, actorId, cardId);
      pendingBanish[actorId] -= 1;
      doRender();
      schedule(proceedPastBanish);
      return;
    } else {
      ui.banishPrompt = { playerId: actorId };
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
    runMarketAndRefill(state, actorId, null, currentTurnExtraHandCards);
    completeTurn();
    return;
  }

  if (isAiTurn()) {
    doRender();
    schedule(() => {
      const cardId = AI.chooseMarketCard(state, actorId);
      runMarketAndRefill(state, actorId, cardId, currentTurnExtraHandCards);
      completeTurn();
    });
  } else {
    doRender();
  }
}

function completeTurn() {
  const finishedPlayerId = state.currentPlayerId;

  if ((extraTurnCredits[finishedPlayerId] || 0) > 0) {
    extraTurnCredits[finishedPlayerId] -= 1;
    state.log.push(`${state.players[finishedPlayerId].name}이(가) 한 줄 완성 보상으로 한 턴을 더 진행합니다!`);
    ui.selectedCardIds = [];
    ui.pileModal = null;
    state.phase = GAME_PHASE.MAIN_ACTION;
    linesBeforeCurrentAction = state.players[finishedPlayerId].bingoCount;

    if (isAiTurn()) {
      doRender();
      schedule(runAiMainAction);
    } else {
      ui.view = "game";
      doRender();
    }
    return;
  }

  const rawTurnLines = state.log.slice(turnLogStart);
  endTurn(state);
  turnLogStart = state.log.length;
  linesBeforeCurrentAction = state.players[state.currentPlayerId].bingoCount;
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

  ui.view = settings.mode === "ai" ? "game" : "pass";
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

function handleAction(action, target) {
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
      startNewGame();
      break;
    }

    case "back-to-setup": {
      state = null;
      ui = { selectedCardIds: [], view: "setup", toast: null, pileModal: null, banishPrompt: null, lastTurnSummary: null };
      lastScrollKey = null;
      clearTimeout(toastTimer);
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
      const result = useSelectedCards(state, state.currentPlayerId, ui.selectedCardIds);
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
      runMarketAndRefill(state, state.currentPlayerId, target.dataset.cardId, currentTurnExtraHandCards);
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
      const actorId = ui.banishPrompt.playerId;
      banishCardFromDiscard(state, actorId, target.dataset.cardId);
      pendingBanish[actorId] = Math.max(0, (pendingBanish[actorId] || 0) - 1);
      ui.banishPrompt = null;
      proceedPastBanish();
      break;
    }

    case "skip-banish": {
      const actorId = ui.banishPrompt.playerId;
      pendingBanish[actorId] = Math.max(0, (pendingBanish[actorId] || 0) - 1);
      ui.banishPrompt = null;
      proceedPastBanish();
      break;
    }

    case "restart-game": {
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

doRender();
