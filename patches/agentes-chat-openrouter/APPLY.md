# Applying the OpenRouter image and picker patches

Pinned upstream: `agentes-chat/agentes-chat` tag `v0.1.2`, commit
`1abdbe79f5c39f3f4749f02ae8ffa5f469993683`.

The two patches are independent: they touch different files and either can be applied alone.
Patch 0001 carries a test; patch 0002 is one query option change.

## Apply onto v0.1.2

```sh
git clone --branch v0.1.2 https://github.com/agentes-chat/agentes-chat.git agentes-chat
cd agentes-chat
git rev-parse HEAD
# 1abdbe79f5c39f3f4749f02ae8ffa5f469993683

PATCHES=/path/to/patches/agentes-chat-openrouter

git apply --check "$PATCHES/0001-openrouter-images.patch"
git apply --check "$PATCHES/0002-picker-refresh.patch"

git am "$PATCHES/0001-openrouter-images.patch"
git am "$PATCHES/0002-picker-refresh.patch"
```

PowerShell users can run the same commands; replace `$PATCHES/...` with the full Windows paths
(for example `C:\patch\0001-openrouter-images.patch`).

## Expected result

```
$ git log --oneline -2
<sha> fix(client): read the models list again when a key is added
<sha> fix(openrouter): send tool images to models that read them
```

Files touched:

| Patch | Files |
| --- | --- |
| `0001-openrouter-images.patch` | `packages/providers/src/catalog.ts`, `packages/providers/src/openrouter.ts`, `packages/providers/src/types.ts`, `packages/providers/test/openrouter.test.ts` |
| `0002-picker-refresh.patch` | `packages/client/src/api/queries.ts` |

No other files change. `0001` adds the `ModelInfo.inputImages` and `ModelInfo.inputFiles`
capabilities, reads them from OpenRouter's `architecture.input_modalities` (`image` and `file`),
sends each tool-result picture or PDF only to a model that advertises that kind, and keeps the
existing text-only note for the rest. `0002` makes the `/models` query stale immediately and
refetch on window focus, so a newly saved OpenRouter key appears without waiting ten minutes.

## Rollback

While `git am` is stopped on a patch:

```sh
git am --abort
```

After both patches applied:

```sh
git reset --hard 1abdbe79f5c39f3f4749f02ae8ffa5f469993683
```

Use `git reset --hard HEAD~2` instead if the pinned commit is not available locally.

## What to verify after applying

Fast checks:

```sh
bun install --frozen-lockfile
bun test ./packages/providers/test/openrouter.test.ts
bun run --filter '@agenteschat/providers' typecheck
```

`bun run typecheck` for the whole repo still reports the one pre-existing client error at an
unrelated `useQuery` (see `VERIFY.log`); the providers' typecheck above is clean.

The provider test file passes with the patch: 21 pass, 0 fail. The new case covers three models:
`~openai/gpt-luna-latest` (the fixture lists `image` and `file`) sends both an `image_url` part
and a `file` part; `~deepseek/deepseek-flash-latest` (image only) sends the picture, drops the
PDF with its note, and sets `imagesLeftOut`; `~z-ai/glm-latest` (text only) sends neither and
keeps the combined "picture and the PDF" note with `imagesLeftOut: true`.

On a real host, also run the three checks in `QA.md`: the picker shows OpenRouter models after a
key is saved, an image read by a tool reaches an image-reading model, and a text-only request
still works.

The captured apply/am transcript is in `VERIFY.log`.
