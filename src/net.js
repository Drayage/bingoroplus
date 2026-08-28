// Firebase RTDB 온라인 동기화 — HOST-AUTHORITY 패턴.
//
// 공유 Firebase 프로젝트(여러 게임이 한 프로젝트에 입주) 경로 규약:
//   games/bingoroplus/rooms/<roomCode>
//
// 핵심 원칙 (adapted from /home/user/animaldojocrush/js/net.js):
//  1) 오직 호스트 브라우저만 gameLogic.js의 뮤테이터를 호출한다.
//     게스트는 행동 "의도(intent)"만 보내고, 호스트가 적용한 뒤 재전송한 뷰만 렌더한다.
//  2) 쓰기 전 undefined → null 정화 (Firebase는 undefined 값을 거부한다)
//  3) seq 가드 — 트랜잭션으로, 오래된 쓰기가 더 앞선 상태를 덮어쓰지 못하게 한다
//  4) 화면은 서버가 확정한 상태(views.<myPlayerId>)만 렌더한다 — 낙관적 렌더 금지
//  5) 상대의 손패/뽑기덱/버림덱 내용과 미체크 빙고칸 숫자는 원본 그대로 절대 전송하지
//     않는다 — 반드시 redactStateForPlayer()를 거친 "플레이어별 뷰"만 기록한다.
//  6) 새로고침 시 방을 즉시 파괴하지 않는다 — presence는 오프라인 표시만 하고,
//     재입장은 로컬에 저장된 rejoin 정보로 시도한다.
import { FIREBASE_CONFIG } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  onChildAdded,
  off,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const ROOT = "games/bingoroplus/rooms";
const REJOIN_KEY = "bingoroplus_rejoin";

let db = null;
function ensureDb() {
  if (!db) db = getDatabase(initializeApp(FIREBASE_CONFIG));
  return db;
}

const roomPath = (code) => `${ROOT}/${code}`;

// ── undefined 정화: 모든 쓰기는 이 함수를 통과시킬 것 ────────────────────────
export function sanitize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
  return out;
}

export function makeRoomCode(len = 5) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 혼동되는 문자(0/O, 1/I) 제외
  return Array.from({ length: len }, () => chars[(Math.random() * chars.length) | 0]).join("");
}

// ── 재입장 정보 (localStorage) ───────────────────────────────────────────────
export function saveRejoin(info) {
  try {
    localStorage.setItem(REJOIN_KEY, JSON.stringify(info));
  } catch (e) {
    /* 저장 실패는 게임을 막지 않는다 */
  }
}

export function loadRejoin() {
  try {
    const raw = localStorage.getItem(REJOIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearRejoin() {
  try {
    localStorage.removeItem(REJOIN_KEY);
  } catch (e) {
    /* noop */
  }
}

// ── 방 생성 / 참가 / 재입장 ───────────────────────────────────────────────────
export async function createRoom(hostName) {
  const code = makeRoomCode();
  const room = sanitize({
    seq: 0,
    createdAt: serverTimestamp(),
    phase: "lobby",
    players: { P1: { id: "P1", name: hostName || "Player 1", online: true } },
    views: { P1: null, P2: null },
  });
  await set(ref(ensureDb(), roomPath(code)), room);
  saveRejoin({ code, playerId: "P1" });
  return { code, playerId: "P1" };
}

export async function joinRoom(code, guestName) {
  const roomRef = ref(ensureDb(), roomPath(code));
  const snap = await get(roomRef);
  if (!snap.exists()) throw new Error("방을 찾을 수 없습니다: " + code);
  const room = snap.val();
  const existingP2 = room.players && room.players.P2;
  if (existingP2 && existingP2.online && room.phase === "playing") {
    throw new Error("이미 다른 참가자가 있는 방입니다.");
  }
  await update(
    ref(ensureDb(), `${roomPath(code)}/players/P2`),
    sanitize({ id: "P2", name: guestName || "Player 2", online: true })
  );
  saveRejoin({ code, playerId: "P2" });
  return { code, playerId: "P2" };
}

/** 저장된 rejoin 정보로 방이 아직 살아있는지 확인한다. 없으면 null. */
export async function tryRejoin() {
  const info = loadRejoin();
  if (!info) return null;
  const snap = await get(ref(ensureDb(), roomPath(info.code)));
  if (!snap.exists()) {
    clearRejoin();
    return null;
  }
  return { ...info, room: snap.val() };
}

// ── 상태 리댁션 (플레이어별 뷰) ────────────────────────────────────────────────

/** 카드 배열의 개수(length)는 유지하되 실제 값/식별자는 감춘다. */
function maskCards(cards) {
  return (cards || []).map((_, i) => ({ id: `hidden-${i}`, value: null }));
}

/**
 * state를 viewerId 시점에서 봐도 되는 형태로 리댁션한다.
 * 감추는 것: 상대의 손패(hand)/뽑기덱(drawPile)/버림덱(discardPile)/보너스 공개
 * 카드(bonusRevealCards) "내용"과, 상대 빙고판의 "미체크 칸 숫자". 기존 핫싯(기기 넘기기)
 * 모드의 hideOpponentBoard 마스킹과 동일한 범위 — 다만 여기서는 클라이언트 렌더 옵션이
 * 아니라 데이터 자체를 지워서 네트워크로 내보낸다.
 */
export function redactStateForPlayer(state, viewerId) {
  if (!state) return state;
  const clone = typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  const oppId = viewerId === "P1" ? "P2" : "P1";
  const opp = clone.players && clone.players[oppId];
  if (opp) {
    opp.hand = maskCards(opp.hand);
    opp.drawPile = maskCards(opp.drawPile);
    opp.discardPile = maskCards(opp.discardPile);
    opp.bonusRevealCards = maskCards(opp.bonusRevealCards);
    opp.bingoBoard = (opp.bingoBoard || []).map((cell) => (cell.marked ? cell : { ...cell, number: null }));
  }
  return clone;
}

// ── 상태 동기화 (호스트 전용 쓰기, seq 가드) ──────────────────────────────────
/**
 * 호스트가 턴 흐름이 한 단계 전이될 때마다 호출한다. 원본 state는 절대 그대로
 * 기록하지 않고, P1/P2 각각의 리댁션된 뷰만 기록한다.
 * 반환값이 false면 seq가 이미 앞서 있었다는 뜻 — 호출측은 최신 seq로 재시도할 것.
 */
export async function writeState(code, baseSeq, fullState, phase = "playing") {
  const views = sanitize({
    P1: redactStateForPlayer(fullState, "P1"),
    P2: redactStateForPlayer(fullState, "P2"),
  });
  const result = await runTransaction(ref(ensureDb(), roomPath(code)), (cur) => {
    if (!cur) return cur; // 방 없음 — 트랜잭션 중단
    if ((cur.seq || 0) !== baseSeq) return undefined; // 이미 앞선 상태 → 포기
    return { ...cur, seq: baseSeq + 1, phase, views };
  });
  // committed === false면 baseSeq가 이미 낡았다는 뜻 — 호출측은 실제 서버 seq(snapshot에
  // 반영된 현재 값)로 재시도할 것. runTransaction의 snapshot은 실패 시에도 서버의 현재
  // 값을 담고 있다.
  const serverVal = result.snapshot && result.snapshot.val();
  const currentSeq = serverVal ? serverVal.seq || 0 : baseSeq;
  return { committed: result.committed, seq: result.committed ? baseSeq + 1 : currentSeq };
}

// ── 구독 ──────────────────────────────────────────────────────────────────
/** 방 전체(players/phase/seq/views)를 구독한다. 호스트/게스트 둘 다 사용. */
export function subscribeRoom(code, onRoom) {
  const r = ref(ensureDb(), roomPath(code));
  const handler = (snap) => onRoom(snap.val());
  onValue(r, handler);
  return () => off(r, "value", handler);
}

/** 호스트 전용: 게스트가 보낸 의도(intent)를 순서대로 받아 큐에서 제거하며 처리한다. */
export function subscribeIntents(code, onIntent) {
  const r = ref(ensureDb(), `${roomPath(code)}/intents`);
  const handler = (snap) => {
    const key = snap.key;
    const intent = snap.val();
    remove(ref(ensureDb(), `${roomPath(code)}/intents/${key}`));
    if (intent) onIntent(intent);
  };
  onChildAdded(r, handler);
  return () => off(r, "child_added", handler);
}

/** 게스트 전용: "카드 사용", "칸 선택" 등 행동 의도를 호스트에게 전송한다. */
export function sendIntent(code, playerId, action, payload = {}) {
  return push(
    ref(ensureDb(), `${roomPath(code)}/intents`),
    sanitize({ playerId, action, ...payload, ts: serverTimestamp() })
  );
}

// ── presence: 즉시 삭제 금지, 오프라인 표시만 (재입장 유예) ────────────────────
export function setupPresence(code, playerId) {
  const p = ref(ensureDb(), `${roomPath(code)}/players/${playerId}`);
  update(p, { online: true, lastSeen: serverTimestamp() });
  onDisconnect(p).update({ online: false, lastSeen: serverTimestamp() });
}
