import { CONFIG, GAME_PHASE, BINGO_LINES, NUMBER_BANDS } from "./config.js";

let nextCardId = 1;
function makeCard(value) {
  return { id: `c${nextCardId++}`, value };
}

export function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandomDistinct(min, max, count) {
  const pool = [];
  for (let n = min; n <= max; n++) pool.push(n);
  return shuffle(pool).slice(0, count);
}

export function generateBingoBoard() {
  const numbers = [];
  for (const [min, max] of NUMBER_BANDS) {
    numbers.push(...pickRandomDistinct(min, max, CONFIG.BOARD_SIZE));
  }
  const shuffled = shuffle(numbers);

  const board = [];
  let i = 0;
  for (let row = 0; row < CONFIG.BOARD_SIZE; row++) {
    for (let col = 0; col < CONFIG.BOARD_SIZE; col++) {
      board.push({ number: shuffled[i], marked: false, row, col });
      i++;
    }
  }
  return board;
}

export function generateMarketDeck() {
  const deck = [];
  for (let v = CONFIG.MARKET_MIN_NUMBER; v <= CONFIG.MARKET_MAX_NUMBER; v++) {
    for (let c = 0; c < CONFIG.MARKET_COPIES_PER_NUMBER; c++) {
      deck.push(makeCard(v));
    }
  }
  return shuffle(deck);
}

function createPlayer(id, name) {
  return {
    id,
    name,
    bingoBoard: generateBingoBoard(),
    drawPile: [],
    hand: CONFIG.STARTING_DECK.map((v) => makeCard(v)),
    discardPile: [],
    bonusRevealCards: [],
    completedLines: [],
    bingoCount: 0,
    discardStreak: 0,
    bonusDrawReady: false,
  };
}

export function createGameState(options = {}) {
  const marketDeck = generateMarketDeck();
  const marketCards = marketDeck.splice(0, CONFIG.MARKET_DISPLAY_SIZE);
  const requiredLines = options.requiredLines || CONFIG.REQUIRED_BINGO_LINES;
  const p2Name = options.p2Name || "Player 2";

  return {
    phase: GAME_PHASE.MAIN_ACTION,
    currentPlayerId: "P1",
    winnerId: null,
    requiredLines,

    marketDeck,
    marketCards,
    marketDiscard: [],

    lastCalledNumber: null,
    recentChanges: [],

    players: {
      P1: createPlayer("P1", "Player 1"),
      P2: createPlayer("P2", p2Name),
    },

    bonusTurn: {
      active: false,
      playerId: null,
      total: 0,
      revealedCards: [],
      busted: false,
    },

    log: [],

    // --- Turn-flow bookkeeping ------------------------------------------
    // Kept inside state (rather than module-level closure variables in
    // main.js) so the whole session is one serializable blob — required for
    // network play, where the host must be able to broadcast the complete
    // turn-flow context after every transition. See main.js / net.js.
    turnLogStart: 0,
    linesBeforeCurrentAction: 0,
    currentTurnExtraHandCards: 0,
    extraTurnCredits: { P1: 0, P2: 0 },
    pendingBanish: { P1: 0, P2: 0 },
    // Non-null while a player must choose (or skip) a discard-pile card to
    // banish as a line-completion reward. Always mirrors currentPlayerId
    // while set. Part of state (not local `ui`) so a networked guest's
    // client can tell it needs to render its own banish picker.
    banishPrompt: null,
  };
}

function otherPlayerId(playerId) {
  return playerId === "P1" ? "P2" : "P1";
}

function log(state, message) {
  state.log.push(message);
}

// ---------------------------------------------------------------------------
// Cards / hand
// ---------------------------------------------------------------------------

export function getSelectedCardSum(hand, selectedCardIds) {
  return hand
    .filter((card) => selectedCardIds.includes(card.id))
    .reduce((sum, card) => sum + card.value, 0);
}

export function isValidNormalCall(state, playerId, number) {
  if (number < 1 || number > CONFIG.NUMBER_MAX) return false;
  const player = state.players[playerId];
  const cell = player.bingoBoard.find((c) => c.number === number);
  if (!cell) return false;
  if (cell.marked) return false;
  return true;
}

/**
 * All valid normal-call combinations (1-3 cards) currently makeable from a
 * player's hand: which cards to use and the board number it would call.
 */
export function getAchievableCalls(state, playerId) {
  const hand = state.players[playerId].hand;
  const combos = [];
  for (let i = 0; i < hand.length; i++) combos.push([hand[i]]);
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) combos.push([hand[i], hand[j]]);
  }
  if (hand.length === 3) combos.push([hand[0], hand[1], hand[2]]);

  const results = [];
  for (const combo of combos) {
    const sum = combo.reduce((s, c) => s + c.value, 0);
    if (isValidNormalCall(state, playerId, sum)) {
      results.push({ cardIds: combo.map((c) => c.id), sum });
    }
  }
  return results;
}

export function resolveNormalCall(state, playerId, number) {
  state.lastCalledNumber = number;

  const player = state.players[playerId];
  const opponent = state.players[otherPlayerId(playerId)];
  const changes = [];

  const ownCell = player.bingoBoard.find((c) => c.number === number);
  if (ownCell && !ownCell.marked) {
    ownCell.marked = true;
    changes.push({ playerId, number, type: "marked" });
    log(state, `${player.name}이(가) ${number}을(를) 체크했습니다.`);
  }

  const oppCell = opponent.bingoBoard.find((c) => c.number === number);
  if (oppCell && !oppCell.marked) {
    oppCell.marked = true;
    changes.push({ playerId: opponent.id, number, type: "marked" });
    log(state, `${opponent.name}도 ${number}을(를) 체크했습니다.`);
  }

  state.recentChanges = changes;
}

/** Move the given card ids from a player's hand to their discard pile. */
function moveCardsFromHandToDiscard(state, playerId, cardIds) {
  const player = state.players[playerId];
  const moving = player.hand.filter((c) => cardIds.includes(c.id));
  player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
  player.discardPile.push(...moving);
}

export function discardEntireHand(state, playerId) {
  const player = state.players[playerId];
  player.discardPile.push(...player.hand);
  player.hand = [];
  player.discardStreak += 1;
  if (player.discardStreak >= 3) {
    player.bonusDrawReady = true;
  }
  log(state, `${player.name}이(가) 손패를 전부 버렸습니다.`);
}

/** Permanently remove a card from a player's discard pile (it re-enters no pile). */
export function banishCardFromDiscard(state, playerId, cardId) {
  const player = state.players[playerId];
  const idx = player.discardPile.findIndex((c) => c.id === cardId);
  if (idx === -1) return false;
  const [card] = player.discardPile.splice(idx, 1);
  log(state, `${player.name}이(가) 버린 카드 더미에서 ${card.value}을(를) 완전히 제거했습니다.`);
  return true;
}

/**
 * Use 1-3 selected cards from hand to make a normal call.
 * Returns { ok: true, usedAllThree } or { ok: false, error }.
 */
export function useSelectedCards(state, playerId, selectedCardIds) {
  const player = state.players[playerId];
  const selectedCards = player.hand.filter((c) => selectedCardIds.includes(c.id));

  if (selectedCards.length < 1 || selectedCards.length > 3) {
    return { ok: false, error: "카드는 1~3장 선택해야 합니다." };
  }

  const calledNumber = selectedCards.reduce((sum, c) => sum + c.value, 0);

  if (!isValidNormalCall(state, playerId, calledNumber)) {
    return { ok: false, error: "호명할 수 없는 숫자입니다." };
  }

  const usedAllThreeCards = player.hand.length === 3 && selectedCards.length === 3;

  const cardText = selectedCards.map((c) => c.value).join(" + ");
  log(state, `${player.name}이(가) ${cardText}를 사용해 ${calledNumber}을(를) 호명했습니다.`);

  player.discardStreak = 0;
  moveCardsFromHandToDiscard(state, playerId, selectedCardIds);
  resolveNormalCall(state, playerId, calledNumber);
  recalculateAllBingoLines(state);

  return { ok: true, usedAllThreeCards, calledNumber };
}

// ---------------------------------------------------------------------------
// Deck management
// ---------------------------------------------------------------------------

export function reshuffleDiscardIntoDeck(state, playerId) {
  const player = state.players[playerId];
  if (player.discardPile.length === 0) return;
  player.drawPile = shuffle(player.discardPile);
  player.discardPile = [];
  log(state, `${player.name}의 버린 카드 더미를 섞어 새 뽑기 덱을 만듭니다.`);
}

/** Draw one card into the player's hand. Returns the card, or null if none available. */
export function drawCard(state, playerId) {
  const player = state.players[playerId];
  if (player.drawPile.length === 0) {
    reshuffleDiscardIntoDeck(state, playerId);
  }
  if (player.drawPile.length === 0) return null;

  const card = player.drawPile.pop();
  player.hand.push(card);
  return card;
}

export function refillHandToThree(state, playerId, extraCards = 0) {
  const player = state.players[playerId];
  const target = CONFIG.HAND_SIZE + extraCards;
  while (player.hand.length < target) {
    const card = drawCard(state, playerId);
    if (!card) break;
  }
}

/** Draw one card during a bonus turn without adding it to hand. */
function drawCardForBonus(state, playerId) {
  const player = state.players[playerId];
  if (player.drawPile.length === 0) {
    // Only the existing discard pile is reshuffled; cards already revealed
    // this bonus turn stay in the reveal area and are excluded.
    reshuffleDiscardIntoDeck(state, playerId);
  }
  if (player.drawPile.length === 0) return null;
  return player.drawPile.pop();
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export function refillMarket(state) {
  while (state.marketCards.length < CONFIG.MARKET_DISPLAY_SIZE && state.marketDeck.length > 0) {
    state.marketCards.push(state.marketDeck.pop());
  }
}

export function isMarketExhausted(state) {
  return state.marketCards.length === 0 && state.marketDeck.length === 0;
}

export function acquireMarketCard(state, playerId, marketCardId) {
  const player = state.players[playerId];
  const idx = state.marketCards.findIndex((c) => c.id === marketCardId);
  if (idx === -1) return false;

  const [card] = state.marketCards.splice(idx, 1);
  player.discardPile.push(card);
  log(state, `${player.name}이(가) 시장에서 ${card.value}을(를) 가져갔습니다.`);

  refillMarket(state);
  return true;
}

// ---------------------------------------------------------------------------
// Bonus turn
// ---------------------------------------------------------------------------

export function startBonusTurn(state, playerId) {
  const player = state.players[playerId];
  state.bonusTurn = {
    active: true,
    playerId,
    total: 0,
    revealedCards: [],
    busted: false,
  };
  player.bonusRevealCards = [];
  state.phase = GAME_PHASE.BONUS_DRAW;
  log(state, `${player.name}이(가) 보너스턴을 시작합니다.`);

  bonusHit(state);
}

/** Reveal one more card in the current bonus turn. */
export function bonusHit(state) {
  const { playerId } = state.bonusTurn;
  const player = state.players[playerId];
  const card = drawCardForBonus(state, playerId);

  if (!card) {
    // No cards left anywhere: force-resolve at the current total instead of
    // leaving the bonus turn stuck with no cards to draw.
    log(state, `${player.name}의 덱이 모두 소진되어 더 이상 히트할 수 없습니다.`);
    const total = state.bonusTurn.total;
    finishBonusTurn(state, playerId, { applyEffect: total >= 1 });
    return { drewCard: false, busted: false };
  }

  state.bonusTurn.revealedCards.push(card);
  player.bonusRevealCards = state.bonusTurn.revealedCards.slice();
  state.bonusTurn.total += card.value;

  const total = state.bonusTurn.total;
  log(state, `공개: ${card.value} (합계 ${total})`);

  if (total > CONFIG.BONUS_BUST_LIMIT) {
    state.bonusTurn.busted = true;
    log(state, `${player.name}이(가) ${total}으로 버스트했습니다!`);
    finishBonusTurn(state, playerId, { applyEffect: false });
    return { drewCard: true, busted: true };
  }

  return { drewCard: true, busted: false };
}

export function resolveBonusNumber(state, playerId, number) {
  const player = state.players[playerId];
  const opponent = state.players[otherPlayerId(playerId)];
  const changes = [];

  const ownCell = player.bingoBoard.find((c) => c.number === number);
  if (ownCell && !ownCell.marked) {
    ownCell.marked = true;
    changes.push({ playerId, number, type: "marked" });
    log(state, `${player.name}은(는) ${number}을(를) 체크했습니다.`);
  }

  const oppCell = opponent.bingoBoard.find((c) => c.number === number);
  if (oppCell && oppCell.marked) {
    oppCell.marked = false;
    changes.push({ playerId: opponent.id, number, type: "unmarked" });
    log(state, `${opponent.name}의 ${number} 체크가 취소되었습니다.`);
  }

  state.recentChanges = changes;
}

/**
 * End the current bonus turn: move revealed cards to discard pile, and if
 * applyEffect is true, resolve the final total against both boards.
 */
export function finishBonusTurn(state, playerId, { applyEffect }) {
  const player = state.players[playerId];
  const total = state.bonusTurn.total;

  if (applyEffect) {
    resolveBonusNumber(state, playerId, total);
  } else {
    state.recentChanges = [];
  }

  player.discardPile.push(...state.bonusTurn.revealedCards);
  player.bonusRevealCards = [];
  state.bonusTurn = {
    active: false,
    playerId: null,
    total: 0,
    revealedCards: [],
    busted: state.bonusTurn.busted,
  };

  recalculateAllBingoLines(state);
}

export function bonusStand(state) {
  const { playerId, total } = state.bonusTurn;
  if (total < 1 || total > CONFIG.BONUS_BUST_LIMIT) return;

  log(state, `${state.players[playerId].name}이(가) ${total}에서 스탠드했습니다.`);
  finishBonusTurn(state, playerId, { applyEffect: true });
}

// ---------------------------------------------------------------------------
// Bingo / winner
// ---------------------------------------------------------------------------

export function calculateCompletedBingoLines(player) {
  const markedByCoord = new Map();
  for (const cell of player.bingoBoard) {
    markedByCoord.set(`${cell.row},${cell.col}`, cell.marked);
  }

  const completed = [];
  BINGO_LINES.forEach((line, index) => {
    const allMarked = line.every(([r, c]) => markedByCoord.get(`${r},${c}`));
    if (allMarked) completed.push(index);
  });

  player.completedLines = completed;
  player.bingoCount = completed.length;
}

export function recalculateAllBingoLines(state) {
  calculateCompletedBingoLines(state.players.P1);
  calculateCompletedBingoLines(state.players.P2);
}

/**
 * Determine a winner, if any. `actingPlayerId` is the player who just
 * performed the action (used to break simultaneous-win ties).
 * Returns the winning playerId, or null.
 */
export function checkWinner(state, actingPlayerId) {
  const p1 = state.players.P1;
  const p2 = state.players.P2;
  const required = state.requiredLines || CONFIG.REQUIRED_BINGO_LINES;
  const p1Wins = p1.bingoCount >= required;
  const p2Wins = p2.bingoCount >= required;

  let winnerId = null;
  if (p1Wins && p2Wins) {
    if (p1.bingoCount !== p2.bingoCount) {
      winnerId = p1.bingoCount > p2.bingoCount ? "P1" : "P2";
    } else {
      winnerId = actingPlayerId;
    }
  } else if (p1Wins) {
    winnerId = "P1";
  } else if (p2Wins) {
    winnerId = "P2";
  }

  if (winnerId) {
    state.winnerId = winnerId;
    state.phase = GAME_PHASE.GAME_OVER;
    log(state, `${state.players[winnerId].name} 승리!`);
  }

  return winnerId;
}

// ---------------------------------------------------------------------------
// Turn flow helpers
// ---------------------------------------------------------------------------

/** Run the market-pick + refill-hand steps that follow the main action. */
export function runMarketAndRefill(state, playerId, marketCardId, extraHandCards = 0) {
  if (marketCardId && !isMarketExhausted(state)) {
    acquireMarketCard(state, playerId, marketCardId);
  } else if (isMarketExhausted(state)) {
    log(state, "시장의 카드가 모두 소진되어 획득을 진행하지 않습니다.");
  }
  refillHandToThree(state, playerId, extraHandCards);
}

export function endTurn(state) {
  const next = otherPlayerId(state.currentPlayerId);
  state.currentPlayerId = next;
  state.phase = GAME_PHASE.MAIN_ACTION;
  log(state, `--- ${state.players[next].name}의 턴 ---`);
}
