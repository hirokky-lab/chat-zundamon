/* Runs before React/authentication so the last wallpaper also paints the launch screen. */
(() => {
  const key = 'zundamon-ai.wallpaper-bootstrap.v1';
  function apply(value) {
    if (!value || typeof value.background !== 'string' || value.background.length > 350000 || !/^(?:#[a-f0-9]{6}|rgb\([\d ]+\))$/i.test(value.color)) return false;
    const remainder = value.background.replace(/url\("(?:\/backgrounds\/[a-z0-9-]+\.(?:png|jpg|webp)|data:image\/jpeg;base64,[a-z0-9+/=]+)"\)/gi, '');
    if (/url\s*\(/i.test(remainder)) return false;
    // Use hex for Safari's native status bar, including preferences saved as modern rgb().
    const channels = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(value.color);
    const color = channels ? '#' + channels.slice(1).map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : value.color;
    const style = document.documentElement.style;
    style.setProperty('--room-background', value.background);
    style.setProperty('--room-position', /^(?:center|[\d.]+% [\d.]+%)$/.test(value.position) ? value.position : 'center');
    style.setProperty('--room-size', value.size === 'auto 400px' ? value.size : 'cover');
    style.setProperty('--room-repeat', value.repeat === 'repeat' ? 'repeat' : 'no-repeat');
    style.setProperty('--wallpaper-color', color);
    style.backgroundColor = color;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    return true;
  }
  const systemDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const fallback = dark => ({background: `linear-gradient(rgb(${dark ? "46 58 94 / 20%" : "255 251 240 / 30%"}), rgb(${dark ? "46 58 94 / 20%" : "255 251 240 / 30%"})), url("/backgrounds/${dark ? 'edamame-sky-night-v2' : 'edamame-sky-day-v2'}.png")`,position:'center',size:'auto 400px',repeat:'repeat',color:dark?'#2e3a5e':'#fffbf0'});
  let value;
  try { value = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
  const dark = value?.mode === 'system' ? systemDark : value?.mode === 'dark' || (!value?.mode && /night/.test(value?.background || ''));
  let selected = value?.mode ? (dark ? value.night : value.day) : value;
  // Upgrade cached artwork before React so launch and the selected wallpaper agree.
  const pattern = /\/backgrounds\/edamame-(?:(pink|lavender|orange|sky|milktea)-)?(day|night)-v\d+\.png/.exec(selected?.background || '');
  if (pattern) {
    const base = fallback(dark);
    selected = pattern[1] === 'pink'
      ? { ...base, background: base.background.replace('edamame-sky-', 'edamame-pink-') }
      : base;
  }
  const retired = /room-|milktea|data:image/.test(selected?.background || '');
  if (!apply(retired ? fallback(dark) : selected)) apply(fallback(value ? dark : systemDark));
  document.documentElement.dataset.colorMode = (value ? dark : systemDark) ? 'dark' : 'light';
})();
