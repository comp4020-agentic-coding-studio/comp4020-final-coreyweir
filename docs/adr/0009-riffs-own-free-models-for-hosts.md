# 9. Hosts can use Riff's own free models, through the server

- Status: accepted, not yet implemented
- Date: 2026-10-19

## Context

Hosting needs a model endpoint and a token. Course members have the course
key; anyone else, the marker included if they don't paste theirs, sees a
host form they can't get past. Being able to try Riff without bringing a
key is part of it being easy to use.

What was looked at (PLAN, P3):

- **OpenCode Zen's free models.** Measured 19 October: a request without
  a key gets 403 `FreeTierError`, "OpenCode's free tier can only be used
  from within OpenCode". Its terms also forbid getting around an access
  restriction, so imitating OpenCode's client is out.
- **OpenRouter.** Its terms (31 August 2026) allow building it into a
  product for your own users (§5.1), forbid reselling access to the models
  or building a competing service, and forbid extra accounts to get around
  limits (§7). Free models (`:free`) are limited per account: 20 requests a
  minute, and 1000 a day once the account has bought $10 of credit (50
  before). It has an Anthropic-style `POST /api/v1/messages`, and its
  `GET /api/v1/models` is what Claude Code's model discovery reads. Its
  CORS allows any origin, but not the `anthropic-version` and
  `anthropic-beta` headers Claude Code sends, so a browser can't call it
  directly with Claude Code's requests.
- Claude Code (checked locally with OpenRouter, and in the 2.1.221 bundle
  Riff runs): `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` work, and
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` lists the account's
  allowed models from `{base}/v1/models`.

The account: $10 of credit bought once, no payment method saved, a
workspace for the course with a lifetime spending limit of $0.01, and a key
in it limited to $0 and to free text models. Spending is limited there,
twice, so Riff doesn't check models or cost itself.

## Options

1. **Riff's key behind a proxy on our server, for hosts.**
2. **"Connect OpenRouter".** Each host signs in to OpenRouter (OAuth with
   PKCE, all in the browser) and Riff gets a key on their account and
   limits.
3. **Riff's key in the page**, swapped in by the service worker like a
   host's own token (ADR 0007).
4. **No free route**: the host form keeps asking for an endpoint and token.

## Decision

Option 1.

- The key is `OPENROUTER_API_KEY` on the server (a fly secret). Without it,
  the server says so and the host form doesn't offer Riff's models.
- The server forwards `GET /api/model/v1/models`, `POST
  /api/model/v1/messages` and `POST /api/model/v1/messages/count_tokens`
  to `https://openrouter.ai/api/v1/…`, adding the key. Nothing else under
  `/api/model/` exists. The reply streams back as it arrives.
- **Only a room's host may use it.** The server gives the host a model key
  for their room: the room, their member id and a MAC, like the preview key
  (ADR 0006), so there's nothing to store. Every request checks that this
  member is still the room's host and that the room hasn't ended. A
  participant, a removed member, a room that has ended, or no key at all is
  turned away before anything reaches OpenRouter. A model key copied out of
  the room stops working when the room ends.
- **Any host, signed in or not.** A guest can host (ADR 0005), so anyone
  who opens Riff can use the daily allowance, and could use it up. At the
  scale this runs at, that's accepted. If it happens, the fix is requiring
  sign-in to use Riff's models.
- **The guest never sees the model key.** Claude's environment has
  `ANTHROPIC_BASE_URL=<origin>/api/model` and a placeholder token, which
  the service worker swaps for the model key on the way out, for Riff's own
  origin only (ADR 0007). The real OpenRouter key never leaves the server.
- Claude starts with model discovery on and Nemotron 3 Ultra
  (`nvidia/nemotron-3-ultra-550b-a55b:free`) as its default model. The host
  can pick another of the allowed models in Claude's `/model`.
- The host form offers "Riff's free models" (the default when the server
  has a key) or "Your own endpoint" (the base URL and token fields it has
  now).
- **Log:** model requests are tallied per host every 10 seconds, with the
  reply's status and bytes (`model.request status=200 times=N bytes=B`), so
  a 429 shows up. Never what was asked or answered. Refusals are logged as
  denials, like any other.

## Consequences

- **Hosting no longer needs a key.** Hosting takes a name, and GitHub if
  Claude should push. The README's ease-of-use quality and CLAUDE.md's
  "What good means" describe the old path and need updating (the README is
  mine to write).
- **One allowance for everyone.** Riff's hosts share 20 requests a minute
  and 1000 a day. Claude Code makes several requests a turn, so two or
  three busy rooms at once will see 429s. OpenRouter's reply reaches Claude
  as it is, and Claude shows it.
- **Prompts leave from fly, and go to whichever provider OpenRouter routes
  a free model to.** The room isn't told. Any endpoint a host brings has
  the same question.
- **Our server carries model traffic.** Replies stream through node and
  nginx, which must not buffer them, and requests carry whole
  conversations, larger than nginx's default 1 MB body limit. Egress is
  priced, but text is small.
- **ADR 0007 still holds.** It rejected a server proxy for the *host's*
  tokens, which the server shouldn't hold. Riff's own key is the opposite:
  it must never reach a browser.

## The case for the options we didn't pick

2. **Connect OpenRouter.** Each host's own allowance, no shared limit, and
   no question of Riff answering for what hosts do with its key. But a
   marker would need an OpenRouter account before seeing Claude work, and
   the point is to try Riff with nothing. Still the better route if Riff
   had many users; it can sit beside this one later.
3. **Key in the page.** No proxy, no egress. But the page is the user's:
   the key would be one devtools panel away for anyone who hosts, and
   OpenRouter's CORS refuses the headers Claude Code sends anyway.
4. **No free route.** Nothing to run or pay for, and no allowance to share.
   But a marker without a key couldn't see the main thing Riff does.
