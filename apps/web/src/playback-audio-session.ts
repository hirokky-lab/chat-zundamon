type AudioSession = {type: string};
const sessions = new WeakMap<AudioSession, {users: number; previous: string}>();

/** BGM and speech share iOS's page-wide output route. Release only the last lease. */
export function acquirePlaybackAudioSession(): {refresh: () => void; release: () => void} {
  const session = (navigator as Navigator & {audioSession?: AudioSession}).audioSession;
  const noop = {refresh() {}, release() {}};
  if (!session) return noop;
  const state = sessions.get(session) ?? {users: 0, previous: session.type};
  const refresh = () => { try { session.type = 'playback'; } catch { /* Optional browser API. */ } };
  refresh();
  state.users++; sessions.set(session, state);
  let released = false;
  return {refresh, release() {
    if (released) return;
    released = true;
    if (--state.users) return;
    sessions.delete(session);
    if (session.type === 'playback') {
      try { session.type = state.previous; } catch { /* Optional browser API. */ }
    }
  }};
}
