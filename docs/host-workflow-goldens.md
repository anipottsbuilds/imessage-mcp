# Interactive workflow goldens

The protocol suite verifies skill discovery and exact bytes. These opt-in scenarios exercise the
installed Claude Code host with synthetic iMessage data, then score ordered message/chat IDs and
required read-only MCP calls. They do not compare prose. Local evaluator unit tests include known
wrong outcomes and missing or misdirected calls. They do not invoke any model in CI.

## Run locally

Use Node 24.16+ and Claude Code 2.1.331+ with Skills over MCP available in your authenticated,
interactive first-party session. The host uses its existing model account; **only the generated
fictional fixture** is supplied. The host may retain synthetic session history as usual.
Do not point this harness at the real Messages database, edit the generated MCP configuration, or add
other MCP servers or tools. Do not use `claude -p`: Claude does not support these skills in that mode.

```sh
npm run build
case_dir=$(node scripts/host-goldens.mjs prepare new-ask)
node scripts/host-goldens.mjs launch "$case_dir"
```

For the newly generated workspace, verify its path before accepting the standard trust prompt.
Run the slash command shown when launching. Keep the session in manual mode; the harness allowlists
only the named read-only MCP tools. If your host prompts for any other tool, do not approve it.
Save the returned JSON object (without any Markdown fence) to `"$case_dir/answer.json"` after exiting
the session, then score:

```sh
node scripts/host-goldens.mjs score "$case_dir" "$case_dir/answer.json"
```

Repeat in a fresh fixture directory with `cancelled-ask` and `specific-chat`. A nonzero score is a
failure; the four booleans distinguish wrong IDs/order, failure to load the skill, unexpected calls,
and missing search/thread evidence. Record the host/model/version and exact package or commit tested.
Do not treat a failed host invocation, unsupported rollout, unavailable account, or unobserved tool
trace as a pass. Remove the generated fixture directory when finished.

| Case | Distinguishing behavior |
| --- | --- |
| `new-ask` | An old outgoing message does not hide a newer unanswered direct request. Rank by deadline, exclude a group request to somebody else. |
| `cancelled-ask` | Same conversation, plus one cancellation. Remove that ask and retain the other. |
| `specific-chat` | Identical phrase from two senders, with one message shared across two chats. Verify the requested sender and right membership. |

The trace records selected request fields, never text, response bodies, or search terms. This optional
test measures model behavior, which can vary. Keep deterministic protocol and synthetic privacy
coverage as the release gate while collecting enough repeated host results to assess stability.
