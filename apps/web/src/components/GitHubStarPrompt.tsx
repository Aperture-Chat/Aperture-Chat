import { Star } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { answerStarPrompt, checkStarPrompt, type StarPromptAnswer, type StarPromptAsk } from "../lib/api";

export const STAR_REPOSITORY_URL = "https://github.com/Aperture-Chat/Aperture-Chat";
const PROJECT_NAME = "Aperture Chat";

/** The words for each ask. A renamed workspace still says which project the star is for. */
export function starPromptCopy(ask: StarPromptAsk, brandName: string): { title: string; body: string } {
  const renamed = brandName !== PROJECT_NAME;
  if (ask === 1) {
    const intro = renamed ? `${brandName} runs on ${PROJECT_NAME}, a` : `${PROJECT_NAME} is a`;
    return {
      title: `Enjoying ${brandName}?`,
      body: `${intro} free, open-source project. If it's useful to you, a star on GitHub helps others find it.`,
    };
  }
  const project = renamed ? ` for ${PROJECT_NAME}` : "";
  return {
    title: `Still enjoying ${brandName}?`,
    body: `If it has been useful, a star${project} on GitHub is a quick way to say so. We won't ask again.`,
  };
}

/* A quiet card in the top-right corner asking whether the person likes the
 * app and, if so, to star the open-source project on GitHub. The server
 * decides when (a few days in, once more two weeks later, then never) and
 * counts the ask as soon as it hands it out, so this only shows what it is
 * told and reports the answer. */
export function GitHubStarPrompt({
  userId,
  brandName,
  held = false,
}: {
  userId: string;
  brandName: string;
  /** True while another welcome is on screen; the check waits for it. */
  held?: boolean;
}) {
  const [ask, setAsk] = useState<StarPromptAsk | null>(null);
  const checkedFor = useRef<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (held || checkedFor.current === userId) return;
    checkedFor.current = userId;
    checkStarPrompt(userId)
      .then(setAsk)
      .catch(() => {
        // A request for a star is never worth an error on screen.
      });
  }, [held, userId]);

  if (ask === null) return null;

  function answer(choice: StarPromptAnswer) {
    setAsk(null);
    void answerStarPrompt(userId, choice).catch(() => {
      // The ask was already counted when it was shown; nothing to retry.
    });
  }

  const { title, body } = starPromptCopy(ask, brandName);

  return (
    <aside className="github-star-prompt" aria-labelledby={titleId} aria-describedby={bodyId}>
      <span className="github-star-prompt-icon" aria-hidden="true">
        <Star size={18} />
      </span>
      <div className="github-star-prompt-copy">
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="github-star-prompt-actions">
          <a
            className="primary-button"
            href={STAR_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => answer("star")}
          >
            <Star size={15} aria-hidden="true" />
            <span>Star on GitHub</span>
          </a>
          <button className="secondary-button" type="button" onClick={() => answer("later")}>
            Not now
          </button>
        </div>
      </div>
    </aside>
  );
}
