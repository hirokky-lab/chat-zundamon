import { ZUNDAMON_CHARACTER } from "@yui/domain";
import { useState, type FormEvent } from "react";
import type { AddressingStyle } from "@yui/domain";

export type SetupProps = {
  saving: boolean;
  blocked?: boolean;
  error: string | null;
  onSave: (input: { displayName: string; addressingStyle: AddressingStyle }) => void;
};

export function Setup({ saving, blocked = false, error, onSave }: SetupProps) {
  const [displayName, setDisplayName] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || saving || blocked) return;
    onSave({ displayName: name, addressingStyle: "san" });
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-label={`${ZUNDAMON_CHARACTER.displayName}の初期設定`}>
        <div className="setup-welcome-scene">
          <div className="setup-dialogue">
            <p className="setup-speech">なんて呼べばいい？</p>
          </div>
          <img className="setup-character" src="/characters/zundamon/name-jaw-tilt.png" alt="ずんだもん" />
        </div>
        <form onSubmit={handleSubmit}>
          <label className="onboarding-name-label" htmlFor="display-name">あなたの名前</label>
          <input id="display-name" value={displayName} maxLength={20} autoComplete="name" disabled={saving || blocked} onChange={(event) => setDisplayName(event.target.value)} />
          <p className="onboarding-hint">あとから変えられるよ</p>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={saving || blocked || !displayName.trim()}>はじめる</button>
        </form>
      </section>
    </main>
  );
}
