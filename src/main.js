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
import { render } from "./ui.js";

const root = document.getElementById("app-root");

let state = createGameState();
let ui = { selectedCardIds: [], view: "game" };

function doRender() {
  render(state, ui, root);
}

function goToMarketPick() {
  state.phase = GAME_PHASE.MARKET_PICK;
  if (isMarketExhausted(state)) {
    runMarketAndRefill(state, state.currentPlayerId, null);
    completeTurn();
  } else {
    doRender();
  }
}

function completeTurn() {
  endTurn(state);
  ui.selectedCardIds = [];
  ui.view = "pass";
  doRender();
}

function afterBonusTurnEnds() {
  const winner = checkWinner(state, state.currentPlayerId);
  if (winner) {
    doRender();
    return;
  }
  goToMarketPick();
}

function handleAction(action, target) {
  switch (action) {
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
      ui.selectedCardIds = [];

      const winner = checkWinner(state, state.currentPlayerId);
      if (winner) {
        doRender();
        break;
      }

      if (result.usedAllThreeCards) {
        startBonusTurn(state, state.currentPlayerId);
        if (state.bonusTurn.active) {
          doRender();
        } else {
          afterBonusTurnEnds();
        }
      } else {
        goToMarketPick();
      }
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
      state = createGameState();
      ui = { selectedCardIds: [], view: "game" };
      doRender();
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

doRender();
