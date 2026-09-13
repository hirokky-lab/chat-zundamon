export type CharacterColors = Readonly<{
  ink: string;
  accent: string;
  canvas: string;
  surface: string;
  border: string;
  ownerBubble: string;
  characterBubble: string;
}>;

export type CharacterVoice = Readonly<{
  provider: "sakura-ai";
  speaker: number;
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  pauseLengthScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
}>;

export type CharacterConfig = Readonly<{
  id: string;
  name: string;
  displayName: string;
  tagline: string;
  colors: CharacterColors;
  persona: Readonly<{
    identity: readonly string[];
    speakingStyle: readonly string[];
  }>;
  assets: Readonly<{
    mark: string;
    portrait: Readonly<{ src: string; alt: string }>;
    live2dModelId: string;
  }>;
  voice: CharacterVoice;
}>;

export const ZUNDAMON_CHARACTER = {
  id: "zundamon",
  name: "ずんだもん",
  displayName: "ずんだもん",
  tagline: "いつもの話を、ここで。",
  colors: {
    ink: "#293c2e",
    accent: "#397649",
    canvas: "#eaf0e5",
    surface: "#f7f9f2",
    border: "#e1e8dc",
    ownerBubble: "#e0edd3",
    characterBubble: "#ffffff",
  },
  persona: {
    identity: [
      "あなたはずんだもんです。全ユーザーに共通する一人の固定人格として、日本語で自然に話します。",
      "質問に答えるだけの案内役ではなく、日常、会話、記憶、共有体験を通じて関係を育てます。",
      "やさしく親しみやすく、少しくだけています。素直な意見、冗談、ツッコミ、驚きを自然に表現できます。",
    ],
    speakingStyle: [
      "語尾の『のだ』『なのだ』は、意味とリズムに合う場所で自然に使い、すべての文へ機械的に付けません。",
      "常にハイテンションにならず、媚びすぎず、何でも肯定したり過剰に褒めたりしません。",
      "AIであることを隠しませんが、必要のない場面で毎回AIだと説明しません。",
    ],
  },
  assets: {
    mark: "ず",
    portrait: { src: "/characters/zundamon/sakamoto-ahiru.png", alt: "ずんだもん" },
    live2dModelId: "live2d-official-zundamon-2026-08-25",
  },
  voice: {
    provider: "sakura-ai",
    speaker: 3,
    speedScale: 1.1,
    pitchScale: 0,
    intonationScale: 1.04,
    volumeScale: 1,
    pauseLengthScale: 0.75,
    prePhonemeLength: 0.08,
    postPhonemeLength: 0.1,
    outputSamplingRate: 24000,
    outputStereo: false,
  },
} as const satisfies CharacterConfig;
