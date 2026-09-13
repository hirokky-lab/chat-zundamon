import type { AvatarExpression, AvatarFrameInput, AvatarPreview } from './avatar-contract';

/** User-selected authored motions. Wave (without a suffix) means embarrassment. */
export const CONVERSATION_MOTIONS = {
  angry: ['mtnBody_angry'],
  smile: ['mtnBody_laugh3', 'mtnFace_laugh'],
  disagree: ['mtnBody_no2'],
  thinking: ['mtnBody_think3'],
  afraid: ['mtnBody_tremble'],
  shy: ['mtnBody_wave', 'mtnFace_shy'],
  greeting: ['mtnBody_wave3'],
  agree: ['mtnBody_yes'],
  sad: ['mtnFace_sad'],
  surprise: ['mtnFace_surprise'],
} as const;

/** Conservative fallback until replies carry explicit emotion metadata.
 * Only classify the assistant's opening reaction, not words in its explanation.
 */
export function conversationExpression(text: string): AvatarExpression {
  const opening = text.trim().replace(/^[「『\s]+/, '').slice(0, 100);
  if (/^(?:えへへ|てへへ|照れる|恥ずかしい|はずかしい|そんなに褒め|褒められると)/.test(opening)) return 'shy';
  if (/^(?:ぷんぷん|むー[、。！!]|もう、怒|それはひどい|それは許せない)/.test(opening)) return 'angry';
  if (/^(?:こ、怖|こわいよ|怖いよ|ぶるぶる|ひえ[えぇ]|ひゃ[あぁ])/.test(opening)) return 'afraid';
  if (/^(?:びっくり|驚いた|まさか|ええっ|えっ[、。！!?？])/.test(opening)) return 'surprise';
  if (/^(?:悲しい|寂しい|さみしい|それはつら|つらかった|残念|しょんぼり)/.test(opening)) return 'sad';
  if (/^(?:ううん|いやいや|違うのだ|それは違|そうではな)/.test(opening)) return 'disagree';
  if (/^(?:こんにちは|こんばんは|おはよう|おやすみ|またね|ばいばい|バイバイ)/.test(opening)) return 'greeting';
  if (/^(?:うーん|う〜ん|ええと|えっと|少し考|ちょっと考|考えてみ)/.test(opening)) return 'thinking';
  if (/^(?:あはは|ふふ|ありがとう|うれしい|嬉しい|やった|楽し[いみ]|おめでとう)/.test(opening)) return 'smile';
  if (/^(?:うん[、。！!]|そうだね|そうなのだ|なるほど|わかった|了解)/.test(opening)) return 'agree';
  return 'neutral';
}

/** One cue per reply group; do not replay saved history or every speech chunk. */
export function createConversationMotion() {
  let initialized = false, seen: string | undefined, wasPreparing = false;
  let requestId = 0, active: AvatarPreview | undefined;
  const counts = new Map<AvatarExpression, number>();
  const start = (expression: AvatarExpression) => {
    if (expression === 'neutral') { active = undefined; return; }
    const choices = CONVERSATION_MOTIONS[expression];
    const count = counts.get(expression) ?? 0;
    counts.set(expression, count + 1);
    active = { motion: choices[count % choices.length], requestId: ++requestId, loop: false };
  };
  return {
    frame(input: AvatarFrameInput) {
      if (!initialized) { initialized = true; seen = input.expressionKey; }
      const preparing = input.speechState === 'preparing';
      if (preparing && !wasPreparing) start('thinking');
      if (!preparing && wasPreparing) active = undefined;
      wasPreparing = preparing;
      if (!preparing && input.expressionKey !== seen) {
        seen = input.expressionKey;
        start(input.expression ?? 'neutral');
      }
      return active;
    },
    finish() { active = undefined; },
  };
}
