import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { MOTION_GALLERY } from '../src/live2d/motion-gallery-catalog';
import { CONVERSATION_MOTIONS, conversationExpression, createConversationMotion } from '../src/live2d/conversation-motion';
import type { AvatarFrameInput } from '../src/live2d/avatar-contract';

const input = (patch: Partial<AvatarFrameInput> = {}): AvatarFrameInput => ({elapsedMs:0, idle:.5, eyeOpenLeft:1, eyeOpenRight:1, mouthOpen:0, speechState:'silent', volume:0, ...patch});

it('uses exactly the 12 selected official motions, with wave reserved for shyness', () => {
  const selected = Object.values(CONVERSATION_MOTIONS).flat();
  expect(new Set(selected).size).toBe(12);
  for (const id of selected) expect(MOTION_GALLERY.find(motion => motion.id === id)?.duration).toBeGreaterThan(0);
  expect(CONVERSATION_MOTIONS.shy).toContain('mtnBody_wave');
  expect(CONVERSATION_MOTIONS.greeting).toEqual(['mtnBody_wave3']);
});

it('classifies opening reactions rather than negative words inside explanations', () => {
  for (const [text, emotion] of [
    ['えへへ、照れるのだ。','shy'], ['それはひどいのだ！','angry'], ['こ、怖いのだ。','afraid'],
    ['えっ、びっくりしたのだ！','surprise'], ['それはつらかったね。','sad'], ['ううん、違うのだ。','disagree'],
    ['こんにちはなのだ！','greeting'], ['うーん、考えてみるのだ。','thinking'], ['ありがとうなのだ！','smile'],
    ['うん、わかったのだ。','agree'], ['怒るという感情について説明するのだ。','neutral'],
    ['これは悲しい物語なのだ。','neutral'], ['怖い話について調べるのだ。','neutral'],
  ]) expect(conversationExpression(text)).toBe(emotion);
});

it('does not replay history, repeat a reply group, or replay a finished cue', () => {
  const controller = createConversationMotion();
  expect(controller.frame(input({expressionKey:'saved', expression:'greeting'}))).toBeUndefined();
  const cue = controller.frame(input({expressionKey:'new', expression:'shy'}));
  expect(cue?.motion).toBe('mtnBody_wave');
  expect(controller.frame(input({expressionKey:'new', expression:'smile'}))).toBe(cue);
  controller.finish();
  expect(controller.frame(input({expressionKey:'new', expression:'shy'}))).toBeUndefined();
  expect(controller.frame(input({expressionKey:'next', expression:'shy'}))?.motion).toBe('mtnFace_shy');
});

it('plays thinking once during preparation, then reacts to the new reply', () => {
  const controller = createConversationMotion();
  controller.frame(input({expressionKey:'saved'}));
  expect(controller.frame(input({expressionKey:'new', expression:'smile', speechState:'preparing'}))?.motion).toBe('mtnBody_think3');
  controller.finish();
  expect(controller.frame(input({expressionKey:'new', expression:'smile', speechState:'preparing'}))).toBeUndefined();
  expect(controller.frame(input({expressionKey:'new', expression:'smile', speechState:'speaking'}))?.motion).toBe('mtnBody_laugh3');
  controller.finish();
  expect(controller.frame(input({expressionKey:'next', expression:'smile'}))?.motion).toBe('mtnFace_laugh');
});

// Only the external-material check needs a locally prepared official model.
it.skipIf(!existsSync('public/live2d/zundamon/motion-gallery.json'))('validates installed official motion durations (optional local material)', () => {
  const pack = JSON.parse(readFileSync('public/live2d/zundamon/motion-gallery.json', 'utf8'));
  for (const id of Object.values(CONVERSATION_MOTIONS).flat()) expect(pack.motions[id]?.Meta.Duration).toBeGreaterThan(0);
});
