import { GAME_PHASE } from "./config.js";
import {
  createGameState,
  useSelectedCards,
  discardEntireHand,
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

const AI_PLAYER_ID = "P2";
const AI_STEP_DELAY = 550;

const root = document.getElementById("app-root");

let settings = { hideOpponentBoard: false, requiredLines: 3, mode: "pvp" };
let state = null;
let ui = { selectedCardIds: [], view: "setup" };

function doRender() {
  render(state, ui, settings, root);
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
  ui = { selectedCardIds: [], view: "game" };
  doRender();
}

function goToMarketPick() {
  state.phase = GAME_PHASE.MARKET_PICK;
  if (isMarketExhausted(state)) {
    runMarketAndRefill(state, state.currentPlayerId, null);
    completeTurn();
    return;
  }

  if (isAiTurn()) {
    doRender();
    schedule(() => {
      const cardId = AI.chooseMarketCard(state, state.currentPlayerId);
      runMarketAndRefill(state, state.currentPlayerId, cardId);
      completeTurn();
    });
  } else {
    doRender();
  }
}

function completeTurn() {
  endTurn(state);
  ui.selectedCardIds = [];

  if (isAiTurn()) {
    ui.view = "game";
    doRender();
    schedule(runAiMainAction);
  } else {
    ui.view = settings.mode === "ai" ? "game" : "pass";
    doRender();
  }
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
    goToMarketPick();
  }
}

function afterBonusTurnEnds() {
  const winner = checkWinner(state, state.currentPlayerId);
  doRender();
  if (winner) return;
  goToMarketPick();
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
    schedule(goToMarketPick);
    return;
  }

  const result = useSelectedCards(state, pid, decision.cardIds);
  if (!result.ok) {
    discardEntireHand(state, pid);
    doRender();
    schedule(goToMarketPick);
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
      ui = { selectedCardIds: [], view: "setup" };
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
      goToMarketPick();
      break;
    }

    case "pick-market": {
      runMarketAndRefill(state, state.currentPlayerId, target.dataset.cardId);
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
