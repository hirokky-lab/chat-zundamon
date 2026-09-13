import {MenuPage} from '../components/MenuPage';
import {DEFAULT_BGM} from './player';
import type {BgmController} from './use-bgm';
import './bgm-balance.css';

export function BgmBalanceSettings({controller, onBack}: {controller: BgmController; onBack: () => void}) {
  const percent = Math.round(controller.settings.volume * 100);
  return <MenuPage title="BGM音量バランス" onBack={onBack} contentClassName="bgm-balance-settings">
    <p>全体の音量は、スマホ・PCの音量ボタンで調整できます。</p>
    <section className="bgm-balance-card" aria-label="声とBGMのバランス">
      <label htmlFor="bgm-balance">声に対するBGMの大きさ <output>{percent}%</output></label>
      <input id="bgm-balance" type="range" min="0" max="50" value={percent} aria-valuetext={`${percent}%`} onChange={event => controller.update({volume: Number(event.target.value) / 100})} />
      <div className="bgm-balance-scale" aria-hidden="true"><span>小さめ</span><span>大きめ</span></div>
      <p>ずんだもんが話している間は、BGMが自動で小さくなります。</p>
      <button type="button" onClick={() => controller.update({volume: DEFAULT_BGM.volume})}>標準に戻す</button>
    </section>
    {controller.error && <p role="status">{controller.error}</p>}
  </MenuPage>;
}
