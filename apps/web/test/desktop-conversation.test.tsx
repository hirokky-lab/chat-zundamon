import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {Chat} from '../src/screens/Chat';
import {initialChatState} from '../src/chat-controller';
const props={state:initialChatState,hydrating:false,persistenceWarning:false,onSend:vi.fn(),onRetry:vi.fn(),onOpenSettings:vi.fn(),delayedGreetingReplyGroupId:null,onGreetingRevealed:vi.fn()};
it('pastes an image into attachment preparation without sending the message',()=>{
 const selected=vi.fn();render(<Chat {...props} photoInputEnabled onPhotoSelected={selected}/>);
 const file=new File(['image'],'clipboard.png',{type:'image/png'});
 fireEvent.paste(screen.getByRole('textbox',{name:'メッセージ'}),{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>file}]}});
 expect(selected).toHaveBeenCalledWith(file);expect(props.onSend).not.toHaveBeenCalled();
});
it('preserves ordinary text paste and can toggle the desktop log without removing the composer',()=>{
 const selected=vi.fn();render(<Chat {...props} photoInputEnabled onPhotoSelected={selected}/>);
 fireEvent.paste(screen.getByRole('textbox',{name:'メッセージ'}),{clipboardData:{items:[{kind:'string',type:'text/plain'}]}});
 expect(selected).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:'トークを開く'})).toHaveAttribute('aria-expanded','false');
 fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
 expect(screen.getByRole('button',{name:'トークを閉じる'})).toHaveAttribute('aria-expanded','true');
 fireEvent.click(screen.getByRole('button',{name:'トークを閉じる'}));
 expect(screen.getByRole('button',{name:'トークを開く'})).toHaveAttribute('aria-expanded','false');
 expect(screen.getByRole('textbox',{name:'メッセージ'})).toBeInTheDocument();
});
it('shows thinking in the character dialogue without blocking the composer',()=>{
 const pending={...initialChatState,snapshot:{...initialChatState.snapshot,timeline:[{id:'pending',type:'message' as const,role:'user' as const,text:'こんにちは',createdAt:new Date().toISOString(),delivery:'sending' as const}]}};
 const view=render(<Chat {...props} state={pending}/>);
 expect(screen.getByRole('status',{name:'ずんだもんが考え中'})).toBeInTheDocument();
 fireEvent.change(screen.getByRole('textbox',{name:'メッセージ'}),{target:{value:'次の文章'}});
 expect(screen.getByRole('status',{name:'ずんだもんが考え中'})).toBeInTheDocument();
 fireEvent.change(screen.getByRole('textbox',{name:'メッセージ'}),{target:{value:''}});
 view.rerender(<Chat {...props}/>);
 expect(screen.queryByRole('status',{name:'ずんだもんが考え中'})).not.toBeInTheDocument();
});

it('uses playback progress on the stage while keeping the full reply in history',()=>{
 const state={...initialChatState,snapshot:{...initialChatState.snapshot,timeline:[{id:'reply',type:'message' as const,role:'assistant' as const,text:'まだ話していない続き',createdAt:new Date().toISOString(),delivery:'sent' as const}]}};
 const view=render(<Chat {...props} state={state} spokenStageText="" waitingForSpeech/>);
 expect(screen.getByRole('status',{name:'ずんだもんが考え中'})).toBeInTheDocument();
 view.rerender(<Chat {...props} state={state} spokenStageText="今話しているセリフ"/>);
 expect(screen.getByLabelText('ずんだもんの今のセリフ')).toHaveTextContent('今話しているセリフ');
 expect(screen.getByLabelText('ずんだもんの今のセリフ')).not.toHaveTextContent('まだ話していない続き');
 expect(screen.getByLabelText('ずんだもんとの会話')).toHaveTextContent('まだ話していない続き');
});

it('positions ordinary history at the latest message before painting, without smooth scrolling',()=>{
 const original=Element.prototype.scrollIntoView;
 const scroll=vi.fn();Element.prototype.scrollIntoView=scroll;
 try {
  render(<Chat {...props}/>);
  const area=document.querySelector('.chat-scroll-area')!;
  Object.defineProperties(area,{scrollHeight:{configurable:true,value:50000},clientHeight:{configurable:true,value:500}});
  area.scrollTop=100;
  scroll.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
  expect(area.scrollTop).toBe(50000);
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'トークを閉じる'}));
  area.scrollTop=300;
  fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
  expect(area.scrollTop).toBe(50000);
 }finally{Element.prototype.scrollIntoView=original;}
});

it('opens history when returning to a message from memory',()=>{
 const state={...initialChatState,snapshot:{...initialChatState.snapshot,timeline:[{id:'source',type:'message' as const,role:'user' as const,text:'覚えている会話',createdAt:new Date().toISOString(),delivery:'sent' as const}]}};
 render(<Chat {...props} state={state} sourceMessageId="source"/>);
 expect(screen.getByRole('button',{name:'トークを閉じる'})).toHaveAttribute('aria-expanded','true');
 expect(screen.getByTestId('message-source')).toHaveClass('is-memory-source');
});

it('searches within the history without scrolling the outer page, and keeps the message draft',()=>{
 const state={...initialChatState,snapshot:{...initialChatState.snapshot,timeline:[{id:'match',type:'message' as const,role:'user' as const,text:'壁紙の検索テスト',createdAt:new Date().toISOString(),delivery:'sent' as const}]}};
 const outerScroll=vi.spyOn(Element.prototype,'scrollIntoView');
 const focus=vi.spyOn(HTMLElement.prototype,'focus');
 try {
  render(<Chat {...props} state={state}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'メッセージ'}),{target:{value:'送信前の下書き'}});
  fireEvent.click(screen.getByRole('button',{name:'トークを開く'}));
  const area=document.querySelector('.chat-scroll-area') as HTMLElement;
  Object.defineProperties(area,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:300}});
  area.scrollTop=0;
  vi.spyOn(area,'getBoundingClientRect').mockReturnValue({top:100,height:300} as DOMRect);
  vi.spyOn(screen.getByTestId('message-match'),'getBoundingClientRect').mockReturnValue({top:900,height:100} as DOMRect);
  const scroll=vi.fn();Object.defineProperty(area,'scrollTo',{configurable:true,value:scroll});
  outerScroll.mockClear();
  fireEvent.click(screen.getByRole('button',{name:'履歴を検索'}));
  expect(focus).toHaveBeenCalledWith({preventScroll:true});
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'壁紙'}});
  expect(scroll).toHaveBeenCalledWith({top:700,behavior:expect.any(String)});
  expect(outerScroll).not.toHaveBeenCalled();
  expect(document.querySelector('.chat-screen')).toHaveClass('is-history-searching');
  fireEvent.click(screen.getByRole('button',{name:'検索を閉じる'}));
  expect(document.querySelector('.chat-screen')).not.toHaveClass('is-history-searching');
  expect(screen.getByRole('textbox',{name:'メッセージ'})).toHaveValue('送信前の下書き');
 }finally{outerScroll.mockRestore();focus.mockRestore();}
});

it('tracks the mobile keyboard viewport and restores the full height after closing it',()=>{
 const listeners=new Map<string,()=>void>();
 const viewport={width:390,height:844,offsetTop:0,addEventListener:(event:string,fn:()=>void)=>listeners.set(event,fn),removeEventListener:(event:string)=>listeners.delete(event)};
 vi.stubGlobal('visualViewport',viewport);
 try {
  const view=render(<Chat {...props}/>);
  const root=document.querySelector('.chat-screen') as HTMLElement;
  viewport.height=430;viewport.offsetTop=60;listeners.get('resize')?.();
  expect(root.style.getPropertyValue('--visible-height')).toBe('430px');
  expect(root.style.getPropertyValue('--viewport-top')).toBe('60px');
  expect(root.style.getPropertyValue('--resting-height')).toBe('844px');
  viewport.height=844;viewport.offsetTop=0;listeners.get('resize')?.();
  expect(root.style.getPropertyValue('--visible-height')).toBe('844px');
  expect(root.style.getPropertyValue('--viewport-top')).toBe('0px');
  view.unmount();expect(listeners.size).toBe(0);
 }finally{vi.unstubAllGlobals();}
});
