# Document and slide workspace validation

The drafting workspace keeps model instructions outside the deliverable, preserves document edits when switching modes, and provides previews, archive/unarchive, and confirmed deletion in history.

The document toolbar keeps undo/redo, block style, bold/italic/underline, and inline AI editing on the main row. **Text** holds font, size, advanced styles, color, and highlighting; **Paragraph** holds alignment, lists, and quotes; **More** holds copy, the AI edit trail, and word count. **Insert** includes links and citations alongside visual content. Secondary panels preserve text selection, open from the keyboard with Arrow Down, and dismiss with Escape, focus moving outside, or an outside click. On phones, the formatting row remains collapsible.

## Formatting and export

MLA requests use double-spaced 12-point Times New Roman, a student heading before the title, a plain centered title, first-line body indents, hanging reference indents, and a new page for Works Cited. The editor, Word package, and print surface share the formatting markers. Word and PDF do not prepend the internal draft filename above the student heading. Markdown preserves the body without the filename prefix; typography is not represented by Markdown.

For an existing paper, open **Assistant settings → Apply MLA layout**, then save a version. This formats the existing text without calling a model, removes positively identified validator preambles, and supports Undo. Missing student details and unverified citations remain the author's responsibility; formatting does not verify scholarship.

The export panel offers **Choose a location** and **Browser downloads** where a file picker is available. Print / Save as PDF uses the browser print dialog.

## History and persistence

- Opening a saved draft shows a loading state; failed loads show a visible retry message without clearing the editor.
- Archiving a local draft clears its device-only reminder and keeps its contents under Archived. Exporting alone leaves the reminder in place.
- Hovering or keyboard-focusing a history entry opens a text preview without moving its buttons. Previews never render stored HTML as executable content.
- Account documents retain archive state on the server. Archived documents remain recoverable through **Archived → Unarchive**.
- Decks save to the server exactly like documents: a `kind: "deck"` draft holding canonical deck JSON (`deck-json-v1`, 8 MB ceiling, owner + tenant scope, `expected_revision` CAS with 409 on conflict, revision history, archive, search by slide text). The browser cache is a working copy; the "only on this device" rail badge lists decks and documents that have not reached the account, chats whose last save failed, and quarantined legacy history.
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

The deck editor exposes seven scrollable layout previews, five deck color palettes, and a direct link to deck starters and uploaded brand themes. Palette changes preserve slide text, media, and layout and support Undo.

The deck-kind migration uses a direct SQLite column addition with an inline check. Rebuilding the parent draft table would trigger cascading deletion of revision rows. The migration regression test seeds two revisions and checks their exact preservation through upgrade and downgrade with foreign keys enabled.


## Automatic document pagination

Opening an account draft, cached draft, or earlier document version rebuilds its page layout automatically, including older saved HTML that has no page containers. The editor removes its old page-label elements and generated “Page N —” heading prefixes while keeping section titles, links, quotations, and inline page references. The page navigator sits outside the editable document and derives its current/total count from the rendered sheets.

Account saves flatten automatic page containers, join paragraphs split by layout, and retain explicit manual page breaks as durable markers. Page labels never become body text. Browser font/image measurement refines the initial layout; manual edits reflow when focus leaves the document so typing does not move the caret.
