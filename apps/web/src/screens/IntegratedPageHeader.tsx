import { HamburgerMenuIcon } from "@radix-ui/react-icons";
import { type ReactElement } from "react";

type IntegratedPageHeaderProps = {
  onOpenMenu: () => void;
  onCall: () => void;
  callDisabled?: boolean;
  callPreparing?: boolean;
};

export function IntegratedPageHeader({ onOpenMenu, onCall, callDisabled = false, callPreparing = false }: IntegratedPageHeaderProps): ReactElement {
  return <header className="chat-header integrated-page-header">
    <div className="chat-header-bar">
      <div className="header-leading-actions">
        <button className="header-action" type="button" aria-label="メニューを開く" onClick={onOpenMenu}><HamburgerMenuIcon aria-hidden="true" /></button>
      </div>
      <span className="integrated-header-prism zundamon-mark" aria-hidden="true">ず</span>
      <div className="header-trailing-actions">
        <button className="call-action" type="button" aria-label={callPreparing ? "通話を準備しています" : "ずんだもんに電話"} onClick={onCall} disabled={callPreparing || callDisabled}><img src="/phone-handset.svg" alt="" /></button>
      </div>
    </div>
  </header>;
}
