import { CONFIG } from "./config.js";
import { getSelectedCardSum, isValidNormalCall, isMarketExhausted } from "./gameLogic.js";

function otherPlayerId(playerId) {
  return playerId === "P1" ? "P2" : "P1";
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function renderBoard(player, { highlightNumber, highlightIfMarked } = {}) {
  const grid = el("div", "board");
  const sorted = player.bingoBoard.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of sorted) {
    const classes = ["cell"];
    if (cell.marked) classes.push("marked");
    const matchesHighlight = highlightNumber != null && cell.number === highlightNumber;
    if (matchesHighlight) {
      if (highlightIfMarked === undefined) {
        classes.push("highlight");
      } else if (highlightIfMarked === cell.marked) {
        classes.push("highlight");
      }
    }
    const cellEl = el("div", classes.join(" "), String(cell.number));
    grid.appendChild(cellEl);
  }
  return grid;
}

function renderOpponentPanel(state, selfId) {
  const oppId = otherPlayerId(selfId);
  const opp = state.players[oppId];
  const panel = el("section", "panel opponent-panel");

  let highlightNumber = null;
  let highlightIfMarked;
  if (state.bonusTurn.active && state.bonusTurn.playerId === selfId) {
    highlightNumber = state.bonusTurn.total;
    highlightIfMarked = true; // opponent cell would be cancelled if marked
  }

  panel.appendChild(el("h2", "panel-title", `${opp.name} (상대)`));

  const meta = el(
    "div",
    "meta-row",
    `<span>빙고 ${opp.bingoCount}줄</span>` +
      `<span>덱 ${opp.drawPile.length}장</span>` +
      `<span>버림 ${opp.discardPile.length}장</span>` +
      `<span>손패 ${opp.hand.length}장</span>`
  );
  panel.appendChild(meta);
  panel.appendChild(renderBoard(opp, { highlightNumber, highlightIfMarked }));
  return panel;
}

function renderMarket(state) {
  const wrap = el("div", "market");
  wrap.appendChild(el("h3", "sub-title", "시장"));
  const row = el("div", "market-cards");
  const pickable = state.phase === "MARKET_PICK";

  for (const card of state.marketCards) {
    const cardEl = el("button", "card market-card" + (pickable ? " pickable" : ""), String(card.value));
    cardEl.disabled = !pickable;
    if (pickable) {
      cardEl.dataset.action = "pick-market";
      cardEl.dataset.cardId = card.id;
    }
    row.appendChild(cardEl);
  }
  if (state.marketCards.length === 0) {
    row.appendChild(el("div", "empty-note", "시장 카드 없음"));
  }
  wrap.appendChild(row);
  wrap.appendChild(el("div", "market-deck-count", `시장 덱 남은 카드: ${state.marketDeck.length}장`));
  return wrap;
}

function phaseMessage(state) {
  const player = state.players[state.currentPlayerId];
  switch (state.phase) {
    case "MAIN_ACTION":
      return `${player.name}의 턴 - 카드를 선택해 숫자를 호명하거나, 손패를 버리세요.`;
    case "BONUS_DRAW":
      return `${player.name}의 보너스턴 - 히트 또는 스탠드를 선택하세요.`;
    case "MARKET_PICK":
      return isMarketExhausted(state)
        ? `${player.name}의 턴 - 시장이 모두 소진되었습니다.`
        : `${player.name}의 턴 - 시장에서 카드 1장을 가져가세요.`;
    case "GAME_OVER":
      return `${state.players[state.winnerId].name} 승리!`;
    default:
      return "";
  }
}

function renderCenterPanel(state, ui) {
  const panel = el("section", "panel center-panel");
  panel.appendChild(el("div", "turn-banner", phaseMessage(state)));

  if (state.lastCalledNumber != null) {
    panel.appendChild(el("div", "last-called", `최근 호명: ${state.lastCalledNumber}`));
  }

  panel.appendChild(renderMarket(state));

  if (state.phase === "MAIN_ACTION") {
    const player = state.players[state.currentPlayerId];
    const sum = getSelectedCardSum(player.hand, ui.selectedCardIds);
    const preview = el("div", "sum-preview");
    if (ui.selectedCardIds.length > 0) {
      const cardsText = player.hand
        .filter((c) => ui.selectedCardIds.includes(c.id))
        .map((c) => c.value)
        .join(" + ");
      preview.innerHTML = `선택 카드: ${cardsText} &nbsp;→&nbsp; 현재 합계: <strong>${sum}</strong>`;
    } else {
      preview.textContent = "카드를 선택하세요.";
    }
    panel.appendChild(preview);
  }

  if (state.bonusTurn.active) {
    panel.appendChild(renderBonusPanel(state));
  }

  return panel;
}

function renderBonusPanel(state) {
  const box = el("div", "bonus-box");
  box.appendChild(el("h3", "sub-title", "보너스턴"));

  const revealed = el("div", "bonus-revealed");
  for (const card of state.bonusTurn.revealedCards) {
    revealed.appendChild(el("div", "card bonus-card", String(card.value)));
  }
  box.appendChild(revealed);

  const total = state.bonusTurn.total;
  const remaining = CONFIG.BONUS_BUST_LIMIT - total;
  box.appendChild(
    el(
      "div",
      "bonus-total" + (total > CONFIG.BONUS_BUST_LIMIT ? " busted" : ""),
      `현재 합계: <strong>${total}</strong> &nbsp;|&nbsp; 50까지 남은 수치: ${Math.max(remaining, 0)}`
    )
  );

  const btnRow = el("div", "bonus-buttons");
  const hitBtn = el("button", "btn btn-primary", "히트");
  hitBtn.dataset.action = "bonus-hit";
  const standBtn = el("button", "btn btn-secondary", "스탠드");
  standBtn.dataset.action = "bonus-stand";
  btnRow.appendChild(hitBtn);
  btnRow.appendChild(standBtn);
  box.appendChild(btnRow);

  return box;
}

function renderMyPanel(state, ui) {
  const player = state.players[state.currentPlayerId];
  const panel = el("section", "panel my-panel");

  let highlightNumber = null;
  let highlightIfMarked;
  if (state.phase === "MAIN_ACTION" && ui.selectedCardIds.length > 0) {
    const sum = getSelectedCardSum(player.hand, ui.selectedCardIds);
    if (isValidNormalCall(state, state.currentPlayerId, sum)) highlightNumber = sum;
  } else if (state.bonusTurn.active) {
    highlightNumber = state.bonusTurn.total;
    highlightIfMarked = false; // only an unmarked cell of mine can still be checked
  }

  panel.appendChild(el("h2", "panel-title", `${player.name} (나)`));
  const meta = el(
    "div",
    "meta-row",
    `<span>빙고 ${player.bingoCount}줄</span>` +
      `<span>덱 ${player.drawPile.length}장</span>` +
      `<span>버림 ${player.discardPile.length}장</span>`
  );
  panel.appendChild(meta);
  panel.appendChild(renderBoard(player, { highlightNumber, highlightIfMarked }));

  const handWrap = el("div", "hand-wrap");
  handWrap.appendChild(el("h3", "sub-title", "손패"));
  const handRow = el("div", "hand");
  const canSelect = state.phase === "MAIN_ACTION";
  for (const card of player.hand) {
    const selected = ui.selectedCardIds.includes(card.id);
    const cardEl = el("button", "card hand-card" + (selected ? " selected" : ""), String(card.value));
    cardEl.disabled = !canSelect;
    if (canSelect) {
      cardEl.dataset.action = "toggle-card";
      cardEl.dataset.cardId = card.id;
    }
    handRow.appendChild(cardEl);
  }
  if (player.hand.length === 0) {
    handRow.appendChild(el("div", "empty-note", "손패 없음"));
  }
  handWrap.appendChild(handRow);
  panel.appendChild(handWrap);

  if (state.phase === "MAIN_ACTION") {
    const sum = getSelectedCardSum(player.hand, ui.selectedCardIds);
    const canUse =
      ui.selectedCardIds.length > 0 &&
      ui.selectedCardIds.length <= 3 &&
      isValidNormalCall(state, state.currentPlayerId, sum);

    const actions = el("div", "action-buttons");
    const useBtn = el("button", "btn btn-primary", "카드 사용");
    useBtn.dataset.action = "use-cards";
    useBtn.disabled = !canUse;
    actions.appendChild(useBtn);

    const discardBtn = el("button", "btn btn-secondary", "손패 버리기");
    discardBtn.dataset.action = "discard-hand";
    discardBtn.disabled = player.hand.length === 0;
    actions.appendChild(discardBtn);

    panel.appendChild(actions);
  }

  return panel;
}

function renderLog(state) {
  const panel = el("section", "panel log-panel");
  panel.appendChild(el("h3", "sub-title", "게임 로그"));
  const list = el("div", "log-list");
  const recent = state.log.slice(-40);
  for (const line of recent) {
    list.appendChild(el("div", "log-line", line));
  }
  panel.appendChild(list);
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
  });
  return panel;
}

function renderPassOverlay(state) {
  const overlay = el("div", "overlay");
  const box = el("div", "overlay-box");
  const next = state.players[state.currentPlayerId];
  box.appendChild(el("h2", null, `${next.name}, 준비되었나요?`));
  box.appendChild(el("p", null, "기기를 넘긴 뒤 계속하기를 눌러주세요. 상대의 손패는 공개되지 않습니다."));
  const btn = el("button", "btn btn-primary", "계속하기");
  btn.dataset.action = "pass-continue";
  box.appendChild(btn);
  overlay.appendChild(box);
  return overlay;
}

function renderGameOverOverlay(state) {
  const overlay = el("div", "overlay");
  const box = el("div", "overlay-box");
  const winner = state.players[state.winnerId];
  box.appendChild(el("h2", null, `🎉 ${winner.name} 승리!`));
  box.appendChild(
    el(
      "p",
      null,
      `${state.players.P1.name}: ${state.players.P1.bingoCount}줄 / ${state.players.P2.name}: ${state.players.P2.bingoCount}줄`
    )
  );
  const btn = el("button", "btn btn-primary", "다시 하기");
  btn.dataset.action = "restart-game";
  box.appendChild(btn);
  overlay.appendChild(box);
  return overlay;
}

export function render(state, ui, root) {
  root.innerHTML = "";

  if (ui.view === "pass") {
    root.appendChild(renderPassOverlay(state));
    return;
  }

  const app = el("div", "app");
  app.appendChild(renderOpponentPanel(state, state.currentPlayerId));
  app.appendChild(renderCenterPanel(state, ui));
  app.appendChild(renderMyPanel(state, ui));
  app.appendChild(renderLog(state));
  root.appendChild(app);

  if (state.phase === "GAME_OVER") {
    root.appendChild(renderGameOverOverlay(state));
  }
}
