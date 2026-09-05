# Document and slide workspace validation

The drafting workspace keeps model instructions outside the deliverable, preserves document edits when switching modes, and provides previews, archive/unarchive, and confirmed deletion in history.

## Formatting and export

MLA requests use double-spaced 12-point Times New Roman, a student heading before the title, a plain centered title, first-line body indents, hanging reference indents, and a new page for Works Cited. The editor, Word package, and print surface share the formatting markers. Word and PDF do not prepend the internal draft filename above the student heading. Markdown preserves the body without the filename prefix; typography is not represented by Markdown.

For an existing paper, open **Assistant settings → Apply MLA layout**, then save a version. This formats the existing text without calling a model, removes positively identified validator preambles, and supports Undo. Missing student details and unverified citations remain the author's responsibility; formatting does not verify scholarship.

The export panel offers **Choose a location** and **Browser downloads** where a file picker is available. Print / Save as PDF uses the browser print dialog.

## History and persistence

- Hovering or keyboard-focusing a history entry opens a text preview without moving its buttons. Previews never render stored HTML as executable content.
- Account documents retain archive state on the server. Archived documents remain recoverable through **Archived → Unarchive**.
- Decks retain the existing browser-local persistence model. Their history and archives are local to that browser/account scope.
- Delete asks for confirmation and permanently removes that draft's saved revisions. Server deletion and archiving check ownership, tenant, and the displayed revision. A conflicting edit prevents the mutation.
- Deleting the open draft keeps its editor buffer as a working copy; saving it creates a new history entry.

## Coverage

Automated component and package checks cover:

| Surface | Behavior checked |
| --- | --- |
| Assistant composer | Model selection, source and file context, template application, web toggle, reasoning, request submission, unavailable-provider states |
| Document editor | Text styles, colors, highlighting, alignment, links, citations, insertions, page navigation, undo/redo, inline AI edits and edit trail |
| Draft persistence | Save/version comparison/restore, scoped caches, account saves, conflicts, interrupted runs, quota failures, unsaved navigation recovery |
| MLA | Preamble removal, title handling, preservation of paper text, layout undo, Word XML typography and indents, print heading order |
| History | Preview, archive/unarchive across remounts, deletion confirmation, ownership and tenant isolation, stale-revision rejection |
| Deck editor | Conversion, layouts, slide add/duplicate/reorder/delete/undo, text formatting, notes, presentation, templates, image gating, AI revisions |
| Exports | Word and PowerPoint OOXML packages, embedded media, notes, Markdown, save picker, browser-download fallback, print preparation, clipboard rejection and retry |
| Accessibility | Keyboard mode switching, hover/focus preview, dialog focus, mobile drawers and reduced-motion styling |

Live verification uses synthetic documents and decks on the development deployment. Hardware microphone input, every external connector, and every provider/model combination require their own configured environment; component tests do not certify those external services. Native save/print dialogs remain browser/operating-system flows.

The live pass exercised generation, editing, version saving, reload/restore, account archive/unarchive, local deck archives, slide conversion and manipulation, presentation navigation, and browser downloads. The downloaded Word package was checked for the student heading, double spacing, and 12-point text; the downloaded five-slide PowerPoint package retained the edited title and speaker notes.

## Deployment

Migration `20260905_0019` adds the `draft_documents.archived` flag with a false default. Existing content and revisions are preserved. Deploy the API schema-head update with the migration, then rebuild the web client. Do not remove the archive column when rolling back application containers; older code can ignore it.
