import { CONFIG } from "./config.js";
import { getSelectedCardSum, isValidNormalCall, isMarketExhausted } from "./gameLogic.js";

const HUMAN_ID = "P1";

function otherPlayerId(playerId) {
  return playerId === "P1" ? "P2" : "P1";
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function renderBoard(player, { highlightNumber, highlightIfMarked, hideUnmarked } = {}) {
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
    const hidden = hideUnmarked && !cell.marked;
    if (hidden) classes.push("hidden-cell");
    const cellEl = el("div", classes.join(" "), hidden ? "" : String(cell.number));
    grid.appendChild(cellEl);
  }
  return grid;
}

function renderOpponentPanel(state, perspectiveId, settings) {
  const oppId = otherPlayerId(perspectiveId);
  const opp = state.players[oppId];
  const panel = el("section", "panel opponent-panel");

  let highlightNumber = null;
  let highlightIfMarked;
  if (state.bonusTurn.active && state.bonusTurn.playerId === perspectiveId) {
    highlightNumber = state.bonusTurn.total;
    highlightIfMarked = true; // opponent cell would be cancelled if marked
  }

  const title = settings.mode === "ai" ? `${opp.name} 🤖` : `${opp.name} (상대)`;
  panel.appendChild(el("h2", "panel-title", title));

  const meta = el(
    "div",
    "meta-row",
    `<span class="meta-pill">빙고 ${opp.bingoCount}줄</span>` +
      `<span class="meta-pill">덱 ${opp.drawPile.length}장</span>` +
      `<span class="meta-pill">버림 ${opp.discardPile.length}장</span>` +
      `<span class="meta-pill">손패 ${opp.hand.length}장</span>`
  );
  panel.appendChild(meta);
  panel.appendChild(
    renderBoard(opp, { highlightNumber, highlightIfMarked, hideUnmarked: settings.hideOpponentBoard })
  );
  if (settings.hideOpponentBoard) {
    panel.appendChild(el("div", "empty-note", "빙고판 비공개 - 체크된 숫자만 표시됩니다."));
  }
  return panel;
}

function renderMarket(state, isMyTurn) {
  const wrap = el("div", "market");
  wrap.id = "market-section";
  wrap.appendChild(el("h3", "sub-title", "시장"));
  const row = el("div", "market-cards");
  const pickable = state.phase === "MARKET_PICK" && isMyTurn;

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

function phaseMessage(state, settings, isMyTurn) {
  const player = state.players[state.currentPlayerId];
  if (settings.mode === "ai" && !isMyTurn) {
    return `${player.name}가 턴을 진행 중입니다...`;
  }
  switch (state.phase) {
    case "MAIN_ACTION":
      return `${player.name}의 턴 - 카드를 선택해 숫자를 호명하거나, 손패를 버리세요.`;
    case "BONUS_DRAW":
      return `${player.name}의 보너스턴 - 더 뽑거나 중지하세요.`;
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

function renderCenterPanel(state, ui, settings, isMyTurn) {
  const panel = el("section", "panel center-panel");
  const banner = el("div", "turn-banner", phaseMessage(state, settings, isMyTurn));
  if (settings.mode === "ai" && !isMyTurn && state.phase !== "GAME_OVER") {
    banner.classList.add("thinking");
  }
  panel.appendChild(banner);

  if (state.lastCalledNumber != null) {
    panel.appendChild(el("div", "last-called", `최근 호명: ${state.lastCalledNumber}`));
  }

  panel.appendChild(renderMarket(state, isMyTurn));

  if (state.phase === "MAIN_ACTION" && isMyTurn) {
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
    panel.appendChild(renderBonusPanel(state, isMyTurn));
  }

  return panel;
}

function renderBonusPanel(state, isMyTurn) {
  const box = el("div", "bonus-box");
  box.id = "bonus-section";
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

  if (isMyTurn) {
    const btnRow = el("div", "bonus-buttons");
    const hitBtn = el("button", "btn btn-primary", "더 뽑기");
    hitBtn.dataset.action = "bonus-hit";
    const standBtn = el("button", "btn btn-secondary", "중지");
    standBtn.dataset.action = "bonus-stand";
    btnRow.appendChild(hitBtn);
    btnRow.appendChild(standBtn);
    box.appendChild(btnRow);
  }

  return box;
}

function metaPileButton(label, count, pileKind) {
  const btn = el("button", "meta-pill meta-pill-clickable", `${label} ${count}장`);
  btn.dataset.action = "show-pile";
  btn.dataset.pile = pileKind;
  return btn;
}

function renderMyPanel(state, ui, settings, perspectiveId, isMyTurn) {
  const player = state.players[perspectiveId];
  const panel = el("section", "panel my-panel");

  let highlightNumber = null;
  let highlightIfMarked;
  if (isMyTurn && state.phase === "MAIN_ACTION" && ui.selectedCardIds.length > 0) {
    const sum = getSelectedCardSum(player.hand, ui.selectedCardIds);
    if (isValidNormalCall(state, perspectiveId, sum)) highlightNumber = sum;
  } else if (state.bonusTurn.active && state.bonusTurn.playerId === perspectiveId) {
    highlightNumber = state.bonusTurn.total;
    highlightIfMarked = false; // only an unmarked cell of mine can still be checked
  }

  panel.appendChild(el("h2", "panel-title", `${player.name} (나)`));
  const meta = el("div", "meta-row");
  meta.appendChild(el("span", "meta-pill", `빙고 ${player.bingoCount}줄`));
  meta.appendChild(metaPileButton("덱", player.drawPile.length, "draw"));
  meta.appendChild(metaPileButton("버림", player.discardPile.length, "discard"));
  panel.appendChild(meta);
  panel.appendChild(renderBoard(player, { highlightNumber, highlightIfMarked }));

  const handWrap = el("div", "hand-wrap");
  handWrap.id = "hand-section";
  handWrap.appendChild(el("h3", "sub-title", "손패"));
  const handRow = el("div", "hand");
  const canSelect = isMyTurn && state.phase === "MAIN_ACTION";
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

  if (isMyTurn && state.phase === "MAIN_ACTION") {
    const sum = getSelectedCardSum(player.hand, ui.selectedCardIds);
    const canUse =
      ui.selectedCardIds.length > 0 &&
      ui.selectedCardIds.length <= 3 &&
      isValidNormalCall(state, perspectiveId, sum);

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

function renderPassOverlay(state, ui) {
  const overlay = el("div", "overlay");
  const box = el("div", "overlay-box");
  const next = state.players[state.currentPlayerId];

  if (ui.lastTurnSummary) {
    const summaryBox = el("div", "turn-summary");
    summaryBox.appendChild(el("h3", "turn-summary-title", `${ui.lastTurnSummary.playerName}의 지난 턴`));
    for (const line of ui.lastTurnSummary.lines) {
      summaryBox.appendChild(el("div", "turn-summary-line", line));
    }
    box.appendChild(summaryBox);
  }

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
  const btnRow = el("div", "action-buttons overlay-buttons");
  const againBtn = el("button", "btn btn-primary", "다시 하기");
  againBtn.dataset.action = "restart-game";
  const setupBtn = el("button", "btn btn-secondary", "설정으로");
  setupBtn.dataset.action = "back-to-setup";
  btnRow.appendChild(againBtn);
  btnRow.appendChild(setupBtn);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  return overlay;
}

function renderPileModal(kind, player) {
  const overlay = el("div", "overlay");
  const box = el("div", "overlay-box pile-modal");
  const cards = kind === "draw" ? player.drawPile : player.discardPile;
  const title = kind === "draw" ? "내 덱에 남은 카드" : "내가 버린 카드";
  box.appendChild(el("h2", null, `${title} (${cards.length}장)`));

  if (cards.length === 0) {
    box.appendChild(el("p", "empty-note", "카드가 없습니다."));
  } else {
    const sorted = cards.slice().sort((a, b) => a.value - b.value);
    const grid = el("div", "pile-grid");
    for (const card of sorted) {
      grid.appendChild(el("div", "card pile-card", String(card.value)));
    }
    box.appendChild(grid);
  }

  const btn = el("button", "btn btn-secondary", "닫기");
  btn.dataset.action = "close-pile-modal";
  box.appendChild(btn);
  overlay.appendChild(box);
  return overlay;
}

function renderBanishPrompt(state, playerId) {
  const overlay = el("div", "overlay");
  const box = el("div", "overlay-box pile-modal");
  const player = state.players[playerId];
  box.appendChild(el("h2", null, "🎁 한 줄 완성 보상"));
  box.appendChild(el("p", null, "버린 카드 더미에서 한 장을 완전히 제거할 수 있습니다."));

  if (player.discardPile.length === 0) {
    box.appendChild(el("p", "empty-note", "버린 카드가 없습니다."));
  } else {
    const sorted = player.discardPile.slice().sort((a, b) => a.value - b.value);
    const grid = el("div", "pile-grid");
    for (const card of sorted) {
      const btn = el("button", "card pile-card pile-card-clickable", String(card.value));
      btn.dataset.action = "banish-card";
      btn.dataset.cardId = card.id;
      grid.appendChild(btn);
    }
    box.appendChild(grid);
  }

  const skipBtn = el("button", "btn btn-secondary", "건너뛰기");
  skipBtn.dataset.action = "skip-banish";
  box.appendChild(skipBtn);
  overlay.appendChild(box);
  return overlay;
}

function renderToast(toast) {
  const box = el("div", "toast");
  box.appendChild(el("div", "toast-title", toast.title));
  for (const line of toast.lines) {
    box.appendChild(el("div", "toast-line", line));
  }
  return box;
}

const LINE_OPTIONS = [1, 2, 3, 4, 5];

function renderToggleRow(action, checked, labelText) {
  const row = el("label", "setup-toggle");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.dataset.action = action;
  row.appendChild(checkbox);
  row.appendChild(document.createTextNode(" " + labelText));
  return row;
}

export function renderSetupScreen(settings) {
  const root = el("div", "setup-screen");
  root.appendChild(el("div", "title-badge", "SUM BINGO"));
  root.appendChild(el("p", "setup-subtitle", "숫자 합성 덱빌딩 빙고"));

  const form = el("div", "setup-form");

  // Opponent board visibility
  const sectionVisibility = el("div", "setup-section");
  sectionVisibility.appendChild(el("h3", "setup-label", "상대 빙고판"));
  sectionVisibility.appendChild(
    renderToggleRow("toggle-hide-opponent", settings.hideOpponentBoard, "상대 빙고판 비공개 (체크된 숫자만 표시)")
  );
  form.appendChild(sectionVisibility);

  // Line-completion rewards (multi-select)
  const sectionRewards = el("div", "setup-section");
  sectionRewards.appendChild(el("h3", "setup-label", "한 줄 완성 보상 (복수 선택 가능)"));
  sectionRewards.appendChild(
    renderToggleRow("toggle-reward-banish", settings.rewardBanishCard, "버림 더미에서 카드 한 장 폐기")
  );
  sectionRewards.appendChild(renderToggleRow("toggle-reward-extra-turn", settings.rewardExtraTurn, "한 턴 더 진행"));
  form.appendChild(sectionRewards);

  // Discard-streak correction
  const sectionCorrection = el("div", "setup-section");
  sectionCorrection.appendChild(el("h3", "setup-label", "버리기 보정"));
  sectionCorrection.appendChild(
    renderToggleRow(
      "toggle-discard-correction",
      settings.rewardDiscardCorrection,
      "3연속 버리기 후 카드 사용 시 다음 손패 4장 뽑기"
    )
  );
  form.appendChild(sectionCorrection);

  // Required lines
  const sectionLines = el("div", "setup-section");
  sectionLines.appendChild(el("h3", "setup-label", `완성 빙고 줄 수: ${settings.requiredLines}`));
  const linesRow = el("div", "setup-lines");
  for (const n of LINE_OPTIONS) {
    const btn = el("button", "chip" + (settings.requiredLines === n ? " chip-active" : ""), String(n));
    btn.dataset.action = "set-lines";
    btn.dataset.lines = String(n);
    linesRow.appendChild(btn);
  }
  sectionLines.appendChild(linesRow);
  form.appendChild(sectionLines);

  // Mode
  const sectionMode = el("div", "setup-section");
  sectionMode.appendChild(el("h3", "setup-label", "대전 방식"));
  const modeRow = el("div", "setup-lines");
  const pvpBtn = el("button", "chip" + (settings.mode === "pvp" ? " chip-active" : ""), "패스 앤 플레이 (2인)");
  pvpBtn.dataset.action = "set-mode";
  pvpBtn.dataset.mode = "pvp";
  const aiBtn = el("button", "chip" + (settings.mode === "ai" ? " chip-active" : ""), "AI와 대전");
  aiBtn.dataset.action = "set-mode";
  aiBtn.dataset.mode = "ai";
  modeRow.appendChild(pvpBtn);
  modeRow.appendChild(aiBtn);
  sectionMode.appendChild(modeRow);
  form.appendChild(sectionMode);

  root.appendChild(form);

  const startBtn = el("button", "btn btn-primary start-btn", "게임 시작");
  startBtn.dataset.action = "start-game";
  root.appendChild(startBtn);

  return root;
}

export function render(state, ui, settings, root) {
  root.innerHTML = "";

  if (ui.view === "setup") {
    root.appendChild(renderSetupScreen(settings));
    return;
  }

  if (ui.view === "pass") {
    root.appendChild(renderPassOverlay(state, ui));
    return;
  }

  const perspectiveId = settings.mode === "ai" ? HUMAN_ID : state.currentPlayerId;
  const isMyTurn = state.currentPlayerId === perspectiveId;

  const app = el("div", "app");
  app.appendChild(renderOpponentPanel(state, perspectiveId, settings));
  app.appendChild(renderCenterPanel(state, ui, settings, isMyTurn));
  app.appendChild(renderMyPanel(state, ui, settings, perspectiveId, isMyTurn));
  app.appendChild(renderLog(state));
  root.appendChild(app);

  if (state.phase === "GAME_OVER") {
    root.appendChild(renderGameOverOverlay(state));
  } else if (ui.banishPrompt) {
    root.appendChild(renderBanishPrompt(state, ui.banishPrompt.playerId));
  } else if (ui.pileModal) {
    root.appendChild(renderPileModal(ui.pileModal.kind, state.players[perspectiveId]));
  }

  if (ui.toast) {
    root.appendChild(renderToast(ui.toast));
  }
}
