/* ============================================================
   ambiance.js — slowly random-walking background gradient.
   Stays dark so the hologram and HUD remain readable, but the
   hue drifts and occasionally wanders for a little surprise,
   then is gently pulled back toward the JARVIS cyan/blue range.
   ============================================================ */
(function () {
  "use strict";
  const root = document.documentElement;

  let h1 = 200, h2 = 215;        // current hues
  let t1 = 200, t2 = 215;        // target hues

  function retarget() {
    // mostly cyan→blue (190–235); ~15% of the time wander anywhere briefly
    t1 = (Math.random() < 0.15) ? Math.random() * 360 : 190 + Math.random() * 45;
    t2 = t1 + 12 + Math.random() * 22;
    setTimeout(retarget, 6000 + Math.random() * 9000);
  }

  function tick() {
    h1 += (t1 - h1) * 0.008;
    h2 += (t2 - h2) * 0.008;
    root.style.setProperty("--g1", `hsl(${h1.toFixed(1)}, 65%, 12%)`);
    root.style.setProperty("--g2", `hsl(${h2.toFixed(1)}, 55%, 4%)`);
    requestAnimationFrame(tick);
  }

  retarget();
  tick();
})();
