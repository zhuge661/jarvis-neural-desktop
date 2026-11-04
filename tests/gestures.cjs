"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
let now = 1000, zoom = 6, writes = 0, drawn = 0, rotations = 0, pointed = 0, poseLocked = false, pulses = 0;
const HUD = new Proxy({}, { get: () => () => {} });
const Hologram = { getZoom: () => zoom, setZoom: (z) => { zoom = z; writes++; },
  setLocked(v) { poseLocked = v; },
  setHandPresent() {}, setPointer() { rotations++; }, pulse() { pulses++; } };
const Knowledge = { clearPointer() {}, point() { pointed++; } };
const context = vm.createContext({ window: { Knowledge }, Knowledge, HUD, Hologram, performance: { now: () => now },
  document: { baseURI: "http://localhost/" }, URL,
  ctx: new Proxy({}, { get: (_, key) => key === "clearRect" ? () => {} : () => { drawn++; } }) });
let source = fs.readFileSync(path.join(__dirname, "../app/backend/JARVIS-main/ui/js/handtracking.js"), "utf8");
source = source.replace("window.HandTracking =", `
  window.testHands = { handleResults, isOpenPalm, isOK, isOne, numHands: NUM_HANDS };
  video = { videoWidth: 640, videoHeight: 480 };
  overlay = { width: 1440, height: 900 }; octx = ctx;
  window.HandTracking =`);
vm.runInContext(source, context);
const api = context.window.testHands;
function hand(x, closed = false, angle = 0) {
  const pts = [[0,.16],[-.055,.11],[-.09,.05],[-.12,-.01],[-.15,-.07],
    [-.06,0],[-.07,-.09],[-.075,-.16],[-.08,-.22],
    [0,0],[0,-.11],[0,-.19],[0,-.26],
    [.055,.01],[.065,-.09],[.075,-.16],[.08,-.22],
    [.10,.035],[.13,-.04],[.15,-.10],[.17,-.15]];
  if (closed) for (const i of [4,8,12,16,20]) pts[i] = [0,.08];
  return pts.map(([px, py]) => ({ x: x + .5 * (px * Math.cos(angle) - py * Math.sin(angle)),
    y: .5 + .5 * (px * Math.sin(angle) + py * Math.cos(angle)), z: 0 }));
}
function feed(hands, frames = 1, labels = []) {
  for (let i = 0; i < frames; i++) { now += 33; api.handleResults({ landmarks: hands,
    handedness: labels.map(categoryName => [{ categoryName }]) }); }
}
assert.equal(api.numHands, 2);
assert.ok(api.isOpenPalm(hand(.3)));
assert.ok(api.isOpenPalm(hand(.3, false, Math.PI / 2)));
assert.ok(!api.isOpenPalm(hand(.3, true)));
feed([hand(.3)], 20); feed([hand(.3, true)], 20);
assert.equal(writes, 0, "one hand must never zoom");
assert.equal(poseLocked, false, "a fist must no longer lock pose");
context.window.HandTracking.setLocked(false);
feed([hand(.35), hand(.65)], 10);
assert.equal(zoom, 6, "acquisition holds the existing size");
feed([hand(.2), hand(.8)], 30);
assert.ok(zoom < 4, "two palms apart must enlarge");
const enlarged = zoom;
feed([hand(.2)], 20); feed([], 20);
assert.equal(zoom, enlarged, "single/lost/closed hand holds size");
feed([hand(.1), hand(.9)], 10);
assert.equal(zoom, enlarged, "reacquisition must not jump");
feed([hand(.35), hand(.65)], 30);
assert.ok(zoom > enlarged + 1, "palms together must shrink");
const shrunk = zoom;
feed([hand(.35), hand(.65, true)], 10);
assert.equal(zoom, shrunk, "one closed palm ends zoom");
context.window.HandTracking.setLocked(false);
feed([hand(.35), hand(.65)], 10);
const stable = zoom;
feed([hand(.65), hand(.35)], 10);
feed([hand(.351), hand(.649)], 10);
assert.equal(zoom, stable, "hand order and small jitter must not change size");
context.window.HandTracking.setConsumer(() => {});
feed([hand(.1), hand(.9)], 15);
assert.equal(zoom, stable, "file map consumer must not change core zoom");
context.window.HandTracking.setConsumer(null);
feed([hand(.2), hand(.8)], 10);
feed([hand(.44), hand(.56)], 30);
assert.ok(zoom <= 11 && zoom >= 3, "zoom must stay bounded");
assert.equal(drawn, 0, "hand skeleton and joints must not render");
function okHand(x, angle = 0) {
  const lm = hand(x, false, angle);
  lm[8] = { ...lm[4] };
  return lm;
}
function oneHand(x) {
  const lm = hand(x, true);
  lm[8] = hand(x)[8];
  return lm;
}
assert.ok(api.isOK(okHand(.25)));
assert.ok(api.isOK(okHand(.25, Math.PI / 2)), "tilted OK must be recognized");
assert.ok(!api.isOK(hand(.25)), "open palm must not be OK");
assert.ok(!api.isOK(hand(.25, true)), "fist must not be OK");
assert.ok(!api.isOpenPalm(okHand(.25)), "OK must not count as an open palm and immediately unlock");
feed([okHand(.25)], 3, ["Left"]);
assert.equal(poseLocked, false, "brief OK must not lock");
feed([hand(.25)], 1, ["Left"]);
feed([okHand(.25)], 10, ["Left"]);
assert.equal(poseLocked, false, "interrupted OK hold must restart timing");
feed([], 1);
feed([okHand(.25)], 17, ["Left"]);
assert.ok(poseLocked, "sustained OK must lock");
feed([okHand(.25)], 30, ["Left"]);
assert.ok(poseLocked, "holding OK must not toggle lock or count as an open palm");
const rotationCount = rotations, zoomWrites = writes;
feed([okHand(.25), hand(.7)], 20, ["Left", "Right"]);
assert.ok(pointed > 0, "other index finger must select knowledge nodes");
assert.equal(rotations, rotationCount, "pointing hand must not rotate locked core");
assert.equal(writes, zoomWrites, "pointing hand must not zoom locked core");
feed([hand(.7), okHand(.25)], 20, ["Right", "Left"]);
assert.ok(poseLocked, "landmark order must not swap lock owner");
feed([hand(.7)], 20, ["Right"]);
assert.ok(poseLocked, "another open hand must not unlock a missing lock owner");
feed([], 20);
assert.ok(poseLocked, "tracking loss must retain pose");
feed([hand(.25), hand(.7)], 12, ["Left", "Right"]);
assert.equal(poseLocked, false, "only original hand reopening releases lock");
assert.ok(api.isOne(oneHand(.4)));
assert.ok(!api.isOne(okHand(.4)));
assert.ok(!api.isOne(hand(.4, true)));
const pulseBefore = pulses;
feed([oneHand(.4)], 3);
assert.equal(pulses, pulseBefore, "brief index pose must not pulse");
feed([hand(.4)], 1);
feed([oneHand(.4)], 12);
assert.equal(pulses, pulseBefore + 1, "index 1 gesture must pulse once");
feed([oneHand(.4)], 60);
assert.equal(pulses, pulseBefore + 1, "holding index must not repeat pulses");
feed([hand(.4)], 2);
feed([oneHand(.4)], 12);
assert.equal(pulses, pulseBefore + 2, "new index pose after release must pulse again");
feed([oneHand(.4), oneHand(.7)], 20);
assert.equal(pulses, pulseBefore + 2, "two hands must not trigger single-hand pulse");
feed([okHand(.25)], 17, ["Left"]);
assert.ok(poseLocked);
const lockedPulseCount = pulses;
feed([okHand(.25), oneHand(.7)], 30, ["Left", "Right"]);
feed([oneHand(.7)], 30, ["Right"]);
assert.equal(pulses, lockedPulseCount, "pointing while locked must never trigger pulse");
// Reacquiring both open palms must recover zoom even when the old OK owner's
// handedness/location no longer matches, then allow continuous in/out reversal.
feed([hand(.3), hand(.7)], 6, ["Right", "Right"]);
assert.ok(poseLocked, "brief two-palm detection must not release the lock");
feed([okHand(.25), oneHand(.7)], 2, ["Left", "Right"]);
assert.ok(poseLocked, "pointing must cancel two-palm takeover arming");
feed([hand(.3), hand(.7)], 20, ["Right", "Right"]);
assert.equal(poseLocked, false, "two open palms must recover zoom independently of owner identity");
zoom = 6;
context.window.HandTracking.setLocked(false);
feed([hand(.3), hand(.7)], 10);
feed([hand(.15), hand(.85)], 30);
const takeoverEnlarged = zoom;
assert.ok(takeoverEnlarged < 4, "two-palm takeover must still enlarge");
feed([hand(.39), hand(.61)], 30);
assert.ok(zoom > takeoverEnlarged + 2, "closing palms after enlarging must shrink without release");
context.window.HandTracking.setLocked(true);
feed([hand(.3)], 20, ["Right"]);
assert.ok(poseLocked, "one open palm cannot take over a manually locked pose");
feed([hand(.3), hand(.7)], 20, ["Left", "Right"]);
assert.equal(poseLocked, false, "two palms also recover zoom from the lock button");
console.log("Two-hand zoom, release latch, jitter, consumer and hidden skeleton: PASS");
console.log("OK confirmation, fist rejection, owner identity, tracking loss and open-palm release: PASS");
console.log("Index-1 pulse, debounce, one pulse per hold and locked pointing separation: PASS");
console.log("Two-palm takeover after owner identity loss/manual lock and continuous shrink reversal: PASS");
