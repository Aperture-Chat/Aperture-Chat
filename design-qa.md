# Prompt Editing Design QA

## Source truth

- Browser Comment 1 attachment in this task: agent System prompt and Meta prompt fields.
- Browser Comment 2 attachment in this task: prompt-template Content field.
- Browser Comments 3 and 4 attachments in this task: chat pencil action and composer.
- Source viewport: 912 x 728 CSS pixels. The attachments are conversation-local and do not have filesystem paths.
- Existing design language retained: Aperture teal, quiet icon actions, soft blue-gray surfaces, rounded controls, compact helper copy, and the composer progress rail proportions.

## Implementation evidence

- Chat composer expanded state: visually verified in a conversation-local QA capture.
- Agent System prompt expanded state: visually verified in a conversation-local QA capture.
- Prompt-template Content expanded state: visually verified in a conversation-local QA capture.
- Implementation viewport: 912 x 728 CSS pixels, matching the supplied references.
- State: authenticated Platform Owner seed data in a local browser QA environment. The local environment intentionally had no connected provider, so the pencil was visually verified in its disabled state; successful improvement, progress, and restore behavior were verified with mocked provider responses in automated tests.

## Comparison findings

1. The first chat expanded-state capture inherited the empty-composer shrink-to-fit rule and rendered about 482 pixels wide. This was corrected by stretching the fixed composer within its viewport insets. The final capture is about 839 pixels wide and preserves comfortable edge margins.
2. The first agent expanded-state capture repeated the expand icon beside the Collapse button. The expanded header now keeps only the prompt improver and the clearly labeled Collapse action.
3. Agent, Meta, and template fields use the same compact action grammar as the chat composer: AI pencil, restore, and four-corner expand icons with quiet teal hover treatment.
4. Expanded editors retain the product's typography, border radii, muted chrome, and teal progress treatment instead of introducing a visually separate tool.
5. The chat expanded state clearly says that collapse is required before sending. Send and send-options are disabled, while Enter remains available for multiline editing.
6. Large editors expose modal semantics, support Escape collapse, lock background scrolling, retain unsaved draft changes, and show character counts without competing with the writing surface.
7. No clipping, overflow, broken margins, or console-visible runtime failures were found in the three final key states.

## Verification history

- Visual QA: browser screenshots compared at the supplied 912 x 728 viewport.
- Interaction QA: chat expand/collapse and disabled sending, agent System prompt expand/collapse, and template Content expand/collapse.
- Automated QA: 43 web test files and 535 tests passed.
- Production build: TypeScript and Vite production build passed.

Final result: passed
