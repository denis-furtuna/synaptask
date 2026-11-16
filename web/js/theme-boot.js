// Runs in <head> before first paint (classic script).
(function () {
  // Refuse to be shown inside a frame: GitHub Pages cannot send frame-ancestors,
  // and the consent page must never be clickjacked.
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location = window.location.href; } catch (e) { /* blocked: stay hidden */ }
  }
  var allowed = ['panel', 'blueprint', 'pcb', 'scope', 'cad', 'pad', 'datasheet', 'cryo', 'midnight', 'paper', 'terminal', 'pastel'];
  var t = null;
  try { t = localStorage.getItem('synaptask:theme'); } catch (e) { /* storage blocked */ }
  try { t = JSON.parse(t); } catch (e) { /* stored by an older version as a bare string */ }
  document.documentElement.setAttribute('data-theme', allowed.indexOf(t) >= 0 ? t : 'panel');
})();
