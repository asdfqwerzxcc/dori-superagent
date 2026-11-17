# QA on a real host

This lane could run unit tests, type checks and patch application, but not the three checks below.
Mark each one from your own run; do not read them as passing because the patches apply.

Why they are unverified here: this workstation has no running agentes.chat server with an
OpenRouter key, no OpenRouter credit to make a model call, and no Docker or WSL to bring one up.
The brief forbids opening a real PR or using production secrets, so the checks stay here as
steps with a pass condition.

## 1. OpenRouter models appear in the picker after a key is saved

Status: UNVERIFIED

Steps:

1. Start a server built from v0.1.2 with both patches applied, and sign in to a workspace with no
   OpenRouter key.
2. Open the agent model picker once, so `/models` is fetched and cached with no OpenRouter entries.
3. Go to Settings > Keys, add an OpenRouter API key, and let the dialog finish.
4. Stay in the same tab and open the model picker again, then switch to another window and back.
5. Search for an OpenRouter model, for example `~deepseek/deepseek-flash-latest` or
   `~anthropic/claude-sonnet-latest`.

Pass: the OpenRouter models appear without a full reload and without waiting ten minutes. The
first refetch can take a second while the server reads OpenRouter's public list. The server's
`openRouterInUse` cache is cleared when the key is saved; if the key was inserted directly in the
database, allow its 30-second cache before retrying.

Fail to report: the list stays empty after a picker remount and a window focus; the server logs a
failed `/api/v1/models` read; or only the greyed picks appear (which means `openRouterInUse` still
read false).

## 2. An image read by a tool reaches an image-reading model

Status: UNVERIFIED

Steps:

1. On the same host, give an agent an OpenRouter model whose list shows image input, for example
   `~deepseek/deepseek-flash-latest`, `~anthropic/claude-sonnet-latest` or `openai/gpt-6-luna`.
2. In a channel, upload a PNG with unmistakable content, for example a red square with the word
   OPENROUTER in white, and ask the agent to open that file with its file-reading tool and say
   what it sees.
3. Repeat with a text-only OpenRouter model, for example `~z-ai/glm-latest`.

Pass: the image-reading model's reply describes the picture (the red square, the word). The
text-only model's reply says the picture is not shown to it, using the existing note, and does not
claim the file was empty. A reply that says the picture is not shown on the image-reading model is
a failure: it means the capability or the image part did not reach the request.

Optional evidence: put a recording proxy in front of `https://openrouter.ai/api/v1` and confirm
the image-reading request carries an `image_url` part with a `data:image/png;base64,...` URL after
the `tool` message, while the text-only request carries no `image_url` part.

## 3. A text-only request still works on OpenRouter

Status: UNVERIFIED

Steps:

1. With an OpenRouter model selected, send an ordinary text message such as "Reply with the word
   hello."
2. Also run one tool round trip that returns text only, for example ask the agent to list the files
   in a folder.

Pass: both complete normally, with no `400` from OpenRouter and no note about a picture that was
never there. This check catches a regression in the message reshaping: a text-only conversation
must produce exactly the same system, user, assistant and `tool` messages as v0.1.2.

## Already verified in this lane

- Both patches apply to `1abdbe79f5c39f3f4749f02ae8ffa5f469993683` with `git apply --check`
  (exit 0) and apply with `git am` (exit 0). See `VERIFY.log`.
- `bun test ./packages/providers/test/openrouter.test.ts`: 21 pass, 0 fail, 152 assertions,
  including the picture-only, picture-plus-PDF, and text-only cases.
- `bun run --filter '@agenteschat/providers' typecheck`: exit 0.
- `bun run --filter '@agenteschat/client' typecheck`: one pre-existing error at
  `packages/client/src/api/queries.ts` (line 5668 with the patch, 5662 without it) about an
  unrelated `useQuery` overload at line 5662; it is present on the pinned tree too. The changed
  `useModels` block adds no error.
