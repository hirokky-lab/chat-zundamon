import {fireEvent} from '@testing-library/react';
import {expect,it} from 'vitest';
import {trackInputModality} from '../src/input-modality';
it('keeps tap focus and restoration separate from keyboard navigation',()=>{
 const dispose=trackInputModality();
 const button=document.createElement('button');document.body.append(button);
 try {
  fireEvent.keyDown(document,{key:'Tab'});
  expect(document.documentElement.dataset.inputModality).toBe('keyboard');
  fireEvent.pointerDown(button,{pointerType:'touch'});button.focus();
  expect(document.documentElement.dataset.inputModality).toBe('pointer');
  fireEvent.keyDown(document,{key:'Escape'});
  expect(document.documentElement.dataset.inputModality).toBe('keyboard');
  fireEvent.pointerDown(button,{pointerType:'mouse'});button.focus();
  expect(document.documentElement.dataset.inputModality).toBe('pointer');
 } finally {button.remove();dispose();}
 expect(document.documentElement.dataset.inputModality).toBeUndefined();
 fireEvent.keyDown(document,{key:'Tab'});
 expect(document.documentElement.dataset.inputModality).toBeUndefined();
});
