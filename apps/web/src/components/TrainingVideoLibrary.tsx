import { Player } from "@remotion/player";
import type { LucideIcon } from "lucide-react";
import { BookOpen, CheckCircle2, ChevronLeft, FileVideo, ListChecks, Volume2, X } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  GuidePdfDownload,
  TRAINING_FPS,
  TRAINING_HEIGHT,
  TRAINING_WIDTH,
  TrainingComposition,
  formatDuration,
  getVideoDuration,
  type FocusRegion,
  type TrainingVideoBase,
} from "./trainingVideoKit";

/* Shared shell for the three training-video surfaces (user Help playlist,
 * Admin Console documentation, Platform Owner documentation). The per-audience
 * decks in ./trainingDecks/ supply the frames, scenes, icons, and copy; this
 * file owns the player, the library chrome, and the modal behavior so the
 * three surfaces stay identical without three copies of the shell. */

export type TrainingDeckVideo = TrainingVideoBase & { icon: string };

export type TrainingDeck = {
  /** Badge shown on every scene title card, e.g. "Owner walkthrough". */
  badge: string;
  regions: Record<string, FocusRegion>;
  videos: TrainingDeckVideo[];
  icons: Record<string, LucideIcon>;
  /** The printable role guide paired with this deck. */
  pdf: { href: string; title: string; description: string; tooltip: string };
};

/** Detail view shared by all three surfaces: head, Remotion player, caption
 * note, outcomes, transcript, and the optional setup/quick-reference list.
 * The head buttons come in as slots so each surface keeps its exact chrome. */
function TrainingVideoDetail({
  video,
  deck,
  openKey,
  titleId,
  heading,
  subtitleRest,
  captionNoteWithAudio,
  captionNoteWithoutAudio,
  setupSummary,
  setupSummaryTooltip,
  headStart,
  headEnd,
}: {
  video: TrainingDeckVideo;
  deck: TrainingDeck;
  openKey: number;
  titleId: string;
  heading: string;
  subtitleRest: string;
  captionNoteWithAudio: string;
  captionNoteWithoutAudio: string;
  setupSummary: ReactNode;
  setupSummaryTooltip: string;
  headStart?: ReactNode;
  headEnd?: ReactNode;
}) {
  const durationInFrames = getVideoDuration(video) * TRAINING_FPS;

  return (
    <>
      <div className="modal-head owner-video-head">
        {headStart}
        <div>
          <h2 id={titleId}>{heading}</h2>
          <p>
            {formatDuration(getVideoDuration(video))} {subtitleRest}
          </p>
        </div>
        {headEnd}
      </div>
      <div className="owner-video-player-card">
        <Player
          key={`${video.id}-${openKey}`}
          component={TrainingComposition}
          inputProps={{ video, regions: deck.regions, badge: deck.badge }}
          durationInFrames={durationInFrames}
          fps={TRAINING_FPS}
          compositionWidth={TRAINING_WIDTH}
          compositionHeight={TRAINING_HEIGHT}
          controls
          autoPlay={false}
          clickToPlay
          initialFrame={0}
          initiallyShowControls
          moveToBeginningWhenEnded
          acknowledgeRemotionLicense
          style={{ width: "100%", height: "100%" }}
        />
      </div>
      <div className="owner-video-controls">
        <span className="owner-video-caption-note">
          <Volume2 size={15} />
          {video.audioSrc ? captionNoteWithAudio : captionNoteWithoutAudio}
        </span>
      </div>
      <div className="owner-video-outcomes" aria-label={`${video.title} outcomes`}>
        {video.outcomes.map((outcome) => (
          <span key={outcome}>
            <CheckCircle2 size={14} /> {outcome}
          </span>
        ))}
      </div>
      <details className="owner-video-transcript">
        <summary data-tooltip="Show or hide the full narration text for this walkthrough">Transcript</summary>
        <ol>
          {video.scenes.map((scene) => (
            <li key={scene.title}>{scene.narration}</li>
          ))}
        </ol>
      </details>
      {video.setupSteps?.length ? (
        <details className="owner-video-transcript">
          <summary data-tooltip={setupSummaryTooltip}>{setupSummary}</summary>
          <ol>
            {video.setupSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

/** Library screen for the console documentation modals: header, guide PDF,
 * and the grid of video cards. */
function TrainingVideoGridLibrary({
  deck,
  docTitleId,
  title,
  description,
  headerLinks,
  onClose,
  onOpenVideo,
}: {
  deck: TrainingDeck;
  docTitleId: string;
  title: string;
  description: string;
  headerLinks?: ReactNode;
  onClose: () => void;
  onOpenVideo: (video: TrainingDeckVideo) => void;
}) {
  return (
    <>
      <div className="modal-head">
        <span className="modal-icon">
          <BookOpen size={22} />
        </span>
        <div>
          <h2 id={docTitleId}>{title}</h2>
          <p>{description}</p>
          {headerLinks}
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close documentation"
          data-tooltip="Close the documentation and return to the console"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <GuidePdfDownload
        href={deck.pdf.href}
        title={deck.pdf.title}
        description={deck.pdf.description}
        tooltip={deck.pdf.tooltip}
      />
      <div className="owner-doc-grid owner-video-grid">
        {deck.videos.map((video) => {
          const Icon = deck.icons[video.icon];
          return (
            <button
              className="owner-doc-card owner-video-card"
              type="button"
              key={video.id}
              aria-label={`Watch ${video.title}`}
              data-tooltip={`Play the ${video.title} walkthrough with narration, captions, and callouts`}
              onClick={() => onOpenVideo(video)}
            >
              <Icon size={20} />
              <span className="owner-video-card-copy">
                <strong>{video.title}</strong>
                <span>{video.description}</span>
                <span className="owner-video-meta">
                  <FileVideo size={14} />
                  {formatDuration(getVideoDuration(video))} Remotion video
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="modal-foot">
        <ListChecks size={15} />
        <span>Walkthroughs use current platform screens, voiceover, synchronized captions, and UI callouts.</span>
      </div>
    </>
  );
}

/** Documentation modal used by the Admin and Platform Owner consoles: a
 * library grid that drills into the shared detail view. */
export function TrainingDocumentationModal({
  deck,
  docTitleId,
  videoTitleId,
  title,
  description,
  backTooltip,
  headerLinks,
  onClose,
}: {
  deck: TrainingDeck;
  docTitleId: string;
  videoTitleId: string;
  title: string;
  description: string;
  backTooltip: string;
  headerLinks?: ReactNode;
  onClose: () => void;
}) {
  const [selectedVideo, setSelectedVideo] = useState<TrainingDeckVideo | null>(null);
  const [openKey, setOpenKey] = useState(0);

  const openVideo = useCallback((video: TrainingDeckVideo) => {
    setOpenKey((key) => key + 1);
    setSelectedVideo(video);
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={`modal owner-doc-modal${selectedVideo ? " owner-video-modal" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={selectedVideo ? videoTitleId : docTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        {selectedVideo ? (
          <TrainingVideoDetail
            video={selectedVideo}
            deck={deck}
            openKey={openKey}
            titleId={videoTitleId}
            heading={`${selectedVideo.title} video`}
            subtitleRest="walkthrough on current platform screens with narration and callouts."
            captionNoteWithAudio="Voiceover, captions, and title cards use the same timeline."
            captionNoteWithoutAudio="Captions and title cards use the same timeline."
            setupSummary="Setup checklist"
            setupSummaryTooltip="Show or hide the step-by-step setup instructions for this topic"
            headStart={
              <button
                className="icon-button"
                type="button"
                aria-label="Back to documentation videos"
                data-tooltip={backTooltip}
                onClick={() => setSelectedVideo(null)}
              >
                <ChevronLeft size={18} />
              </button>
            }
            headEnd={
              <button
                className="icon-button"
                type="button"
                aria-label="Close documentation"
                data-tooltip="Close this video and return to the console"
                onClick={onClose}
              >
                <X size={17} />
              </button>
            }
          />
        ) : (
          <TrainingVideoGridLibrary
            deck={deck}
            docTitleId={docTitleId}
            title={title}
            description={description}
            headerLinks={headerLinks}
            onClose={onClose}
            onOpenVideo={openVideo}
          />
        )}
      </section>
    </div>
  );
}

/** Drawer playlist used by the user Help surface: a row list that opens the
 * shared detail view in a body-level modal. */
export function TrainingGuidePlaylist({
  deck,
  brandName,
  introTagline,
}: {
  deck: TrainingDeck;
  brandName?: string | null;
  introTagline: string;
}) {
  const [selectedVideo, setSelectedVideo] = useState<TrainingDeckVideo | null>(null);
  const [openKey, setOpenKey] = useState(0);
  const guideBrand = brandName?.trim() || "Aperture Chat";

  const openVideo = useCallback((video: TrainingDeckVideo) => {
    setOpenKey((key) => key + 1);
    setSelectedVideo(video);
  }, []);

  const totalSeconds = deck.videos.reduce((total, video) => total + getVideoDuration(video), 0);

  return (
    <>
      <div className="drawer-list user-guide-list">
        <div className="drawer-card user-guide-intro">
          <strong>Learn {guideBrand}</strong>
          <span>
            {deck.videos.length} guided walkthroughs · {formatDuration(totalSeconds)} total. {introTagline}
          </span>
        </div>
        <GuidePdfDownload
          href={deck.pdf.href}
          title={deck.pdf.title}
          description={deck.pdf.description}
          tooltip={deck.pdf.tooltip}
        />
        {deck.videos.map((video) => {
          const Icon = deck.icons[video.icon];
          return (
            <button
              className="drawer-row user-guide-row"
              type="button"
              key={video.id}
              data-tooltip={`Play the ${video.title} walkthrough with captions and callouts`}
              onClick={() => openVideo(video)}
            >
              <Icon size={16} />
              <span>
                <strong>{video.title}</strong>
                <small>{video.description}</small>
              </span>
              <span className="user-guide-duration">
                <FileVideo size={13} />
                {formatDuration(getVideoDuration(video))}
              </span>
            </button>
          );
        })}
      </div>
      {selectedVideo &&
        /* Portal to the body: the utility drawer animates with a transform,
         * which would otherwise trap this fixed backdrop inside the drawer. */
        createPortal(
          <div className="modal-backdrop" role="presentation" onClick={() => setSelectedVideo(null)}>
            <section
              className="modal owner-doc-modal owner-video-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="user-guide-video-title"
              onClick={(event) => event.stopPropagation()}
            >
              <TrainingVideoDetail
                video={selectedVideo}
                deck={deck}
                openKey={openKey}
                titleId="user-guide-video-title"
                heading={selectedVideo.title}
                subtitleRest="walkthrough on real platform screens with callouts and captions."
                captionNoteWithAudio="Voiceover, captions, and title cards share the same timeline."
                captionNoteWithoutAudio="Captions and title cards share the same timeline; the transcript below has the full narration."
                setupSummary={
                  <>
                    <ListChecks size={14} /> Quick reference
                  </>
                }
                setupSummaryTooltip="Show or hide the quick reference steps for this topic"
                headStart={
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Close the user guide video"
                    data-tooltip="Close this walkthrough and return to your workspace"
                    onClick={() => setSelectedVideo(null)}
                  >
                    <X size={17} />
                  </button>
                }
              />
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
