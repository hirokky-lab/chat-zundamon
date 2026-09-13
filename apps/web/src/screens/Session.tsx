import {SpeechLimitError, SPEECH_LIMIT_MESSAGE} from "../sakura-speech";
import type { SessionPhase, SessionState } from "../session-reducer";
import {useEffect, useRef, type ReactNode} from "react";
import {Microphone, MicrophoneSlash, Phone, PhoneDisconnect, HandPalm} from "@phosphor-icons/react";
import {readVoiceAudioSignal} from "../voice-audio-signal";

export type SessionProps = {
  ending: boolean;
  onEnd: () => void;
  state: SessionState;
  avatar?: ReactNode;
  onMute?: () => void;
  onInterrupt?: () => void;
};

const phaseLabels: Record<SessionPhase, string> = {
  connecting: "接続中",
  listening: "聞いています",
  speaking: "話しています",
  ended: "終了しています",
  error: "接続できませんでした",
};

export function Session({ ending, onEnd, state, onMute, onInterrupt }: SessionProps) {
  const faceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame: number;
    const update = () => {
      const volume = Math.max(0, Math.min(1, readVoiceAudioSignal().volume));
      faceRef.current?.style.setProperty("--voice-level", String(volume));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);
  const latestAssistant = state.turns.slice().reverse().find(
    (turn) => turn.role === "assistant",
  );
  const microphoneLabel = state.microphoneEnabled
    ? "マイク使用中"
    : state.phase === "connecting"
      ? "マイク準備中"
      : "マイク停止中";

  return (
    <main className="session-screen zundamon-live-screen">
      <header className="session-heading"><Phone size={22} aria-hidden="true" /><h1 className="session-name">ずんだもんと通話中</h1></header>

      <section className="yui-presence" aria-label="ずんだもんとの会話">
        <div ref={faceRef} className={`live-face is-${state.phase}`}>
          <span className="live-face-ring" aria-hidden="true" />
          <img src="/icons/zundamon-512-v2.png" alt="ずんだもん" />
        </div>
        <div className="session-speech-slot">
        {latestAssistant ? (
          <p className="latest-line" aria-live="polite" tabIndex={0} aria-label="今回の返答">
            {latestAssistant.text}
          </p>
        ) : null}
        </div>
        <p className="session-phase" aria-live="polite">
          {ending ? "終了しています" : phaseLabels[state.phase]}
        </p>
        {state.phase === "error" ? (
          <p className="connection-error" role="alert">
            {state.error instanceof SpeechLimitError ? SPEECH_LIMIT_MESSAGE : "ずんだもんとの接続に失敗しました。マイクは停止しています"}
          </p>
        ) : null}
      </section>

      <div className="session-bottom-stack">
      <details className="transcript">
        <summary>文字起こし</summary>
        <div className="transcript-content" role="region" aria-label="通話の文字起こし" tabIndex={0}>
        {state.turns.length > 0 ? (
          <ol>
            {state.turns.map((turn, index) => (
              <li key={`${turn.role}-${index}`}>
                {turn.role === "assistant" ? "ずんだもん" : "あなた"}：{turn.text}
              </li>
            ))}
          </ol>
        ) : (
          <p>会話が始まると、ここに表示されます。</p>
        )}
        </div>
      </details>

      <footer className="session-controls">
        <p className="microphone-state">
          <span className="microphone-dot" aria-hidden="true" />
          {microphoneLabel}
        </p>
        <div className="live-control-buttons">
          <button type="button" className="live-mute" aria-label={state.microphoneEnabled ? "マイクをミュート" : "マイクをオン"} aria-pressed={!state.microphoneEnabled} onClick={onMute} disabled={ending}>
            {state.microphoneEnabled ? <Microphone size={26} /> : <MicrophoneSlash size={26} />}
          </button>
          <button type="button" className="live-interrupt" aria-label="返事を止めて話す" onClick={onInterrupt} disabled={ending || state.phase !== "speaking"}><HandPalm size={26} /></button>
          <button className="end-action" type="button" onClick={onEnd} disabled={ending} aria-label="ライブチャットを終了"><PhoneDisconnect size={28} /><span>{ending ? "終了中" : "終了"}</span></button>
        </div>
      </footer>
      </div>
    </main>
  );
}
