// Applies the saved theme before first paint (classic script, loaded in <head>).
(function () {
  var allowed = ['panel', 'blueprint', 'pcb', 'scope', 'cad', 'pad', 'datasheet', 'cryo', 'midnight', 'paper', 'terminal', 'pastel'];
  var t = null;
  try { t = localStorage.getItem('synaptask:theme'); } catch (e) { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', allowed.indexOf(t) >= 0 ? t : 'panel');
})();
