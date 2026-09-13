import { wallpaperBackground, WALLPAPER_THEMES, type WallpaperController, type DisplayMode } from "../wallpaper";
import "./wallpaper-settings.css";
export function WallpaperSettings({controller}: {controller: WallpaperController}) {
  const {wallpaper,ready,saving,error,save}=controller;
  const modes: Array<{id:DisplayMode;label:string}>=[{id:"system",label:"端末に合わせる"},{id:"light",label:"ライト"},{id:"dark",label:"ダーク"}];
  return <div className="wallpaper-settings">
    <p>トークとメニューの背景を選べます。</p>
    <fieldset disabled={!ready||saving}><legend>表示モード</legend><div className="wallpaper-tones">
      {modes.map(mode=><button key={mode.id} type="button" aria-pressed={(wallpaper.mode??(wallpaper.tone==="night"?"dark":"light"))===mode.id} onClick={()=>void save({...wallpaper,mode:mode.id})}>{mode.label}</button>)}
    </div></fieldset>
    <fieldset disabled={!ready||saving}><legend>壁紙</legend><div className="wallpaper-grid">
      {WALLPAPER_THEMES.map(theme=><button key={theme.id} type="button" className="wallpaper-choice" aria-pressed={wallpaper.theme===theme.id} onClick={()=>void save({...wallpaper,theme:theme.id})}><span className="wallpaper-swatch" style={{backgroundImage:wallpaperBackground(theme.id,wallpaper.tone)}}/><span>{theme.label}</span></button>)}
    </div></fieldset>
    {error?<p role="alert">{error}</p>:null}
    <p className="wallpaper-note">壁紙と表示モードはこのブラウザに保存されます。</p>
  </div>;
}
