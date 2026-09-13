/* The wallpaper covers the physical standalone window, independently of keyboard/layout insets. */
(() => {
  const root = document.documentElement;
  const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches === true;
  const update = () => {
    let height = window.innerHeight;
    if (standalone()) {
      // Some iOS versions subtract the status bar from innerHeight and fixed insets.
      // Select the matching screen axis also on devices that retain portrait screen dimensions.
      const screen = window.screen;
      const portraitAxis = Math.abs(window.innerWidth - screen.width) <= Math.abs(window.innerWidth - screen.height);
      height = Math.max(height, portraitAxis ? screen.height : screen.width);
    }
    root.style.setProperty('--wallpaper-height', height + 'px');
  };
  update();
  window.addEventListener('resize', update);
  window.addEventListener('pageshow', update);
})();
