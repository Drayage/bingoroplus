import { CONFIG, BINGO_LINES } from "./config.js";
import { isValidNormalCall } from "./gameLogic.js";

function otherPlayerId(playerId) {
  return playerId === "P1" ? "P2" : "P1";
}

function markedCountInLinesThrough(board, row, col) {
  const markedByCoord = new Map();
  for (const cell of board) markedByCoord.set(`${cell.row},${cell.col}`, cell.marked);

  let best = 0;
  for (const line of BINGO_LINES) {
    if (!line.some(([r, c]) => r === row && c === col)) continue;
    const count = line.filter(([r, c]) => markedByCoord.get(`${r},${c}`)).length;
    if (count > best) best = count;
  }
  return best;
}

/** All non-empty subsets (size 1-3) of a hand of at most 3 cards. */
function handCombinations(hand) {
  const combos = [];
  for (let i = 0; i < hand.length; i++) combos.push([hand[i]]);
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) combos.push([hand[i], hand[j]]);
  }
  if (hand.length === 3) combos.push([hand[0], hand[1], hand[2]]);
  return combos;
}

/**
 * Decide the AI's main action for its turn: either use a subset of its hand
 * to make a normal call, or discard the whole hand if nothing useful works.
 */
export function chooseMainAction(state, aiPlayerId) {
  const player = state.players[aiPlayerId];
  const opponent = state.players[otherPlayerId(aiPlayerId)];
  const combos = handCombinations(player.hand);

  let bestCombo = null;
  let bestScore = -Infinity;

  for (const combo of combos) {
    const sum = combo.reduce((s, c) => s + c.value, 0);
    if (!isValidNormalCall(state, aiPlayerId, sum)) continue;

    const ownCell = player.bingoBoard.find((c) => c.number === sum);
    const oppCell = opponent.bingoBoard.find((c) => c.number === sum && !c.marked);

    let score = 0;

    const ownLineProgress = markedCountInLinesThrough(player.bingoBoard, ownCell.row, ownCell.col);
    if (ownLineProgress === 4) score += 1000; // completes a line
    else if (ownLineProgress === 3) score += 200; // 4th cell of a line
    else if (ownLineProgress === 2) score += 60;
    else score += 20;

    if (oppCell) {
      score -= 15; // helping the opponent is a downside, but rarely worth refusing a good call
    }

    const usedAllThree = player.hand.length === 3 && combo.length === 3;
    if (usedAllThree) score += 40; // bonus turn is generally worth pursuing

    // Slight preference for using fewer/smaller cards, to keep flexible cards in hand.
    score -= combo.reduce((s, c) => s + c.value, 0) * 0.05;

    if (score > bestScore) {
      bestScore = score;
      bestCombo = combo;
    }
  }

  if (!bestCombo) {
    return { type: "discard" };
  }
  return { type: "use", cardIds: bestCombo.map((c) => c.id) };
}

function estimateBustProbability(player, remainingBudget) {
  const pool = [...player.drawPile, ...player.discardPile];
  if (pool.length === 0) return 0;
  const bustCount = pool.filter((c) => c.value > remainingBudget).length;
  return bustCount / pool.length;
}

/**
 * Decide hit or stand during the AI's bonus turn.
 */
export function decideBonusAction(state) {
  const { playerId, total } = state.bonusTurn;
  const player = state.players[playerId];
  const opponent = state.players[otherPlayerId(playerId)];

  const ownCell = player.bingoBoard.find((c) => c.number === total);
  const oppCell = opponent.bingoBoard.find((c) => c.number === total);
  const ownUseful = Boolean(ownCell && !ownCell.marked);
  const oppUseful = Boolean(oppCell && oppCell.marked);

  if (ownUseful) {
    const progress = markedCountInLinesThrough(player.bingoBoard, ownCell.row, ownCell.col);
    if (progress >= 3) return "stand"; // would complete or nearly complete a line
  }
  if (ownUseful || oppUseful) {
    const remaining = CONFIG.BONUS_BUST_LIMIT - total;
    const bustProb = estimateBustProbability(player, remaining);
    if (bustProb > 0.25) return "stand";
  }

  const remaining = CONFIG.BONUS_BUST_LIMIT - total;
  const bustProb = estimateBustProbability(player, remaining);

  if (total < 12) return "hit";
  if (bustProb > 0.55) return "stand";
  if (ownUseful || oppUseful) return "stand";
  return "hit";
}

/**
 * Decide which market card to acquire.
 */
export function chooseMarketCard(state, aiPlayerId) {
  const player = state.players[aiPlayerId];

  let best = state.marketCards[0];
  let bestScore = -Infinity;

  for (const card of state.marketCards) {
    let score = 0;
    const ownCell = player.bingoBoard.find((c) => c.number === card.value && !c.marked);
    if (ownCell) {
      score += 30 + markedCountInLinesThrough(player.bingoBoard, ownCell.row, ownCell.col) * 15;
    }
    // Small cards keep sum-adjustment flexible; big cards make single-card calls easy.
    score += card.value <= 5 ? 8 : card.value >= 18 ? 6 : 3;

    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }

  return best.id;
}
