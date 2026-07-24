export const CONFIG = {
  BOARD_SIZE: 5,
  NUMBER_MAX: 50,

  STARTING_DECK: [1, 2, 3],
  HAND_SIZE: 3,

  MARKET_MIN_NUMBER: 1,
  MARKET_MAX_NUMBER: 25,
  MARKET_COPIES_PER_NUMBER: 2,
  MARKET_DISPLAY_SIZE: 5,

  BONUS_BUST_LIMIT: 50,
  REQUIRED_BINGO_LINES: 3,
};

export const GAME_PHASE = {
  SETUP: "SETUP",
  MAIN_ACTION: "MAIN_ACTION",
  RESOLVE_NORMAL_CALL: "RESOLVE_NORMAL_CALL",
  BONUS_DRAW: "BONUS_DRAW",
  BONUS_RESOLVE: "BONUS_RESOLVE",
  MARKET_PICK: "MARKET_PICK",
  REFILL_HAND: "REFILL_HAND",
  CHECK_WINNER: "CHECK_WINNER",
  TURN_END: "TURN_END",
  GAME_OVER: "GAME_OVER",
};

// [row, col] coordinates for the 12 bingo lines (5 rows, 5 cols, 2 diagonals).
export const BINGO_LINES = [
  [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]],
  [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]],
  [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4]],
  [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4]],

  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]],
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3]],
  [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]],

  [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
  [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]],
];

export const NUMBER_BANDS = [
  [1, 10],
  [11, 20],
  [21, 30],
  [31, 40],
  [41, 50],
];
