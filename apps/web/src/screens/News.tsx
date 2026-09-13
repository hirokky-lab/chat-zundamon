import { ChatCircle } from "@phosphor-icons/react";
import { type ReactElement, type ReactNode } from "react";
import { useIntegratedSwipe } from "../integrated-swipe";
import { createNewsViewModel, type IntegratedSwipeDirection, type NewsViewModel } from "../integrated-ui";

type NewsProps = {
  header?: ReactNode;
  navigation: ReactNode;
  model: NewsViewModel;
  onNavigate?: (direction: IntegratedSwipeDirection) => void;
  onStartConversation?: (draft: string) => void;
};

function stateLabel(model: NewsViewModel): string {
  switch (model.state) {
    case "off": return "ずんだもんはニュースを取りに行っていません。利用できる情報だけをここに表示します。トークはそのまま使えます。";
    case "empty": return "確認しましたが、表示できる情報はまだありません。";
    case "failure": return "いまは情報を表示できません。トークはそのまま使えます。";
    case "ready": return "";
  }
}

export function News({ header, navigation, model, onNavigate, onStartConversation }: NewsProps): ReactElement {
  const validatedModel = createNewsViewModel(model);
  const swipe = useIntegratedSwipe(onNavigate);
  return <main className="integrated-page integrated-shell news-screen" {...swipe}>
    {header}
    <div className="integrated-page-scroll">
    <h1 className={validatedModel.state === "off" ? "sr-only" : undefined}>ニュース</h1>
    {validatedModel.state === "ready" ? <ul className="news-list">{validatedModel.value.map((article) => <li className={`news-row${article.imageUrl ? " has-image" : ""}`} key={article.id}>
      {article.imageUrl ? <img src={article.imageUrl} alt="" /> : null}
      <div><a href={article.url} target="_blank" rel="noreferrer">{article.title}</a><p>{article.source}・<time dateTime={article.publishedAt}>{new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(article.publishedAt))}</time></p></div>
      <button type="button" aria-label={`${article.title}についてずんだもんに話す`} onClick={() => onStartConversation?.(article.title)}><ChatCircle aria-hidden="true" size={20} /></button>
    </li>)}</ul> : <section className="news-empty-state" aria-label="ニュースの状態"><p>{stateLabel(validatedModel)}</p></section>}
    </div>
    {navigation}
  </main>;
}
