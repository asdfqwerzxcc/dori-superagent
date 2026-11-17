# OpenRouter: send tool images to models that read them, and refresh the picker when a key is added

- Status: Draft (upstream PR description; not opened)
- Date: 2026-11-17
- Follows ADR 0087 (OpenRouter), sections 5 (calls) and 9 (pickers).
- Patch series: `0001-openrouter-images.patch`, `0002-picker-refresh.patch`
- Files: `packages/providers/src/catalog.ts`, `packages/providers/src/openrouter.ts`,
  `packages/providers/src/types.ts`, `packages/providers/test/openrouter.test.ts`,
  `packages/client/src/api/queries.ts`

## Context

ADR 0087 put OpenRouter behind the Model Gateway with one adapter for Chat Completions. Two gaps
were left as follow-ups:

1. **Images were dropped for every OpenRouter model.** `packages/providers/src/openrouter.ts`
   called `withoutImages` before building messages, so every tool result's picture or PDF became
   a text note saying the model reads text only. The same file already read
   `architecture.output_modalities` from OpenRouter's public list; `architecture.input_modalities`
   is returned beside it, so the server can know which models accept images without a probe or a
   model call.
2. **The picker could stay empty for ten minutes.** The `/models` query used
   `staleTime: 10 * 60_000`, and the web query client defaults `refetchOnWindowFocus` to false. A
   browser that loaded the list before a workspace saved an OpenRouter key kept that empty list
   across remounts and focus changes. Saving a key in the same tab invalidates the query, but a
   key added in another tab, another browser, or by an admin did not reach this one. The
   server-side alternative, `openRouterInUse` in `packages/engine/src/credentials.ts`, caches the
   answer for 30 seconds and is cleared when the key is saved, so the server is not the ten-minute
   problem.

## Decision

1. **A capability on the catalog entry.** `ModelInfo` gains `inputImages?: true` and
   `inputFiles?: true`. Each is set only when OpenRouter's `architecture.input_modalities` array
   contains `image` or `file` respectively. Absent means the list did not say so, and that keeps
   v0.1.2's behavior for that kind: the item is left out and the agent is told the model reads
   text only.
2. **Media ride in a following user message.** Chat Completions' `tool` message content is text
   only, so a tool result's readable `images` become parts of one `user` message after the tool
   messages of that turn: one "From tool call <id>:" text part, then a
   `{ type: "image_url", image_url: { url: "data:<media>;base64,..." } }` part for a picture or a
   `{ type: "file", file: { filename, file_data } }` part for a PDF. All tool messages of a turn
   stay contiguous, as the API requires.
3. **Only known readers get each kind.** The adapter builds
   `keeps = (image) => !compatible && (image.mediaType === PDF_MEDIA_TYPE ? info?.inputFiles === true :
   info?.inputImages === true)`. `withoutImages(messages, model, keeps)` then leaves out only the
   kinds the model did not advertise, keeps the rest, and writes its note for the dropped items
   alone. `imagesLeftOut: true` is reported when anything was dropped. A model with no list entry
   (the list not read yet) keeps the text-only path, and `compatible` endpoints (a workspace's own
   server, ADR 0146) stay text-only whatever the model id looks like.
4. **The picker reads again.** `useModels` uses `staleTime: 0` and `refetchOnWindowFocus: true`.
   A remount or a return to the window refetches `/models`; the server's list itself is cached
   for an hour and is only read while some workspace has a key, so this is a cheap check, not a
   new OpenRouter request on every focus.

The test added to `packages/providers/test/openrouter.test.ts` covers the matrix with the
fixture's three capability shapes: `~openai/gpt-luna-latest` lists `image` and `file` and sends
both an `image_url` part and a `file` part with no `imagesLeftOut`; `~deepseek/deepseek-flash-latest`
lists `image` only, sends the picture, drops the PDF with "The PDF is not shown to you" and sets
`imagesLeftOut: true`; `~z-ai/glm-latest` lists text only, sends neither, and keeps the combined
"picture and the PDF" note with `imagesLeftOut: true`. The list test also asserts both
capabilities are read from the fixture's `architecture`.

## Consequences

- An image-reading OpenRouter model now receives tool-result pictures instead of a note; a
  file-reading one receives PDFs. A model that advertises only one kind gets that kind and keeps
  the note for the other. The agent's prompt estimate already charged for both (`toolImageChars`),
  so budgeting does not change.
- A text-only model, a not-yet-read list, and a workspace endpoint behave as in v0.1.2 for every
  kind they do not read.
- `/models` is refetched on each picker remount and window focus. The route reads the in-memory
  list, so the cost is a small JSON response; the OpenRouter list is not read again until its
  hour is up or a requested model is missing from an old list.
- No new env vars, tables, routes or client fields. The capability stays server-side; the picker
  does not need to show it.

## Verification

- `git apply --check` for each patch, then `git am` for both, on a pristine clone of
  `1abdbe79f5c39f3f4749f02ae8ffa5f469993683`: all exit 0. Transcript in `VERIFY.log`.
- `bun test ./packages/providers/test/openrouter.test.ts`: 21 pass, 0 fail, 152 assertions.
- `bun run --filter '@agenteschat/providers' typecheck`: exit 0.
- `bun run --filter '@agenteschat/client' typecheck`: one pre-existing error at an unrelated
  `useQuery` (line 5662 on the pinned tree, shifted to 5668 by this patch); no error in the
  changed block.
- Real-host checks (picker, image reply, text-only reply) are listed in `QA.md` and marked
  UNVERIFIED: this lane has no OpenRouter key, running server, or Docker/WSL.

## Considered and not chosen

- **Keep stripping for every model until a separate capability probe exists.** The list already
  carries the answer; a probe would spend a model call per model to learn what the list says.
- **Put image parts in the `tool` message.** Chat Completions' tool content is text-only; the
  request would be rejected before any model saw it.
- **Send images to every OpenRouter model and rely on OpenRouter to strip them.** Models that
  cannot read images fail the whole request, which is what v0.1.2 avoided with the note.
- **Send PDFs to every image-reading model because OpenRouter can parse files.** A model that
  advertises only `image` does not advertise `file`; a `file` part it never took can fail the
  request, so PDFs are gated on `inputFiles` like pictures on `inputImages`.
- **Shorten `staleTime` only, without focus refetch.** It fixes a picker remount but leaves an
  open tab stale after a key is saved elsewhere, which is the reported case.
- **Read `openRouterInUse` without its cache.** The 30-second cache is cleared on key save and is
  not the ten-minute delay; removing it would add a credential query to every picker read.

## References

- ADR 0087, `docs/adr/0087-openrouter.md`.
- OpenRouter image inputs: https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
- OpenRouter PDF inputs: https://openrouter.ai/docs/guides/overview/multimodal/pdfs
- OpenRouter Chat Completions tool calling:
  https://openrouter.ai/docs/guides/features/tool-calling
