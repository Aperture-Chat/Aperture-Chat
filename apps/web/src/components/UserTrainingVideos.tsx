/* Thin re-export kept at the original path so the lazy import in AppShell.tsx
 * and any external references keep working. The deck content lives in
 * ./trainingDecks/user.tsx and the shared shell in ./TrainingVideoLibrary.tsx. */
export { USER_TRAINING_VIDEOS, UserGuidePlaylist } from "./trainingDecks/user";
export type { UserTrainingVideo } from "./trainingDecks/user";
