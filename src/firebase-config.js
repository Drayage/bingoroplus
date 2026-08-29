// Firebase project config — SHARED across the sibling games in this Firebase
// project (see the "games/bingoroplus/rooms/<roomCode>" path convention in
// src/net.js). Real keys have not been provisioned yet for this game; fill
// them in here once they exist. Until then, createRoom()/joinRoom() in
// net.js will fail to connect (getDatabase()/initializeApp() will throw or
// the app will be unable to reach a real database).
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyByKyy7PYBIMi2K1jxH6KmzfWbE2_SsB5A",
  authDomain: "deadline-38cdb.firebaseapp.com",
  databaseURL: "https://deadline-38cdb-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "deadline-38cdb",
  storageBucket: "deadline-38cdb.firebasestorage.app",
  messagingSenderId: "768255871086",
  appId: "1:768255871086:web:ad7713b5a3b8e01f9cbe7f",
};
