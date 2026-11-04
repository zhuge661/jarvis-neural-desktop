/* Independent, persistent local volume sliders. */
(function () {
  "use strict";
  function bind(name, initial, changed) {
    const input = document.getElementById("volume-" + name);
    const label = input.closest(".audio-volume"), output = label.querySelector("output");
    const key = "jarvis-volume-" + name;
    let value = initial;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null && Number.isFinite(Number(saved))) value = Math.max(0, Math.min(100, Number(saved)));
    } catch (_) {}
    function paint() { input.value = value; output.textContent = value + "%"; }
    input.addEventListener("input", () => {
      value = Math.max(0, Math.min(100, Number(input.value) || 0)); paint();
      try { localStorage.setItem(key, String(value)); } catch (_) {}
      changed(value / 100);
    });
    paint();
    return { value: () => value / 100, show(enabled) { label.hidden = !enabled; input.disabled = !enabled; } };
  }
  window.AudioVolumes = { bind };
})();
