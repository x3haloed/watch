## Development

Watch uses Node.js 24 LTS and npm. With nvm installed:

```sh
nvm use
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The build clears `dist/` before compiling, so switching versions cannot retain
generated modules for features that have been deleted.

## V2 preservation checks

The v2 branch preserves these behavior contracts through the memory removal:

- `tests/watch-contract.test.ts` exercises autonomous heartbeat inference, waking
  inbox delivery, progressive book consumption with cursor restoration, and
  scratchpad reentry with user-note preservation.
- `tests/lookout-agent.test.ts` exercises actual agent/provider serialization for
  image/audio/video soundings, retained media, model switching, multi-step tools,
  and interrupted-turn history. Provider responses are deterministic test fixtures;
  these tests do not claim live model or codec compatibility.
- `tests/instance-install.test.ts` checks that v1 and unsupported instance versions
  are rejected without changing their files or sending control commands.

## Scratchpad continuity

The persistent scratchpad (`AGENT.md` and `USER.md`) is v2's durable memory.
`scratchpad_read` reads both files, and `scratchpad_update_agent` updates only
`AGENT.md`. Agent notes enter the instructions at session reentry; user notes
arrive through the existing sampled user-notes stream.

The memory lattice, seed crystals, and refinements have been removed, including
capture, recall, tools, prompt injection, control files, and the companion memory
endpoint. Existing v1 memory files are left untouched and are not read or migrated
by v2. The existing stream system and `curl` behavior remain in place at this
checkpoint; their redesign is separate work.

## Instance Layout

V1 remains available at the `watch-v1-baseline` tag (`cd82345`). V2 development
is on `codex/watch-v2`; existing agents can keep their v1 checkout and instance.

V2 defaults to an instance root at `<clone-parent>/v2/`. `WATCH_INSTANCE_ROOT`
selects an explicit instance root instead. Every v2 configuration must include
`"instanceVersion": 2`; v1 configuration is rejected before runtime files are
created or control commands are sent. This version identifies the v2 instance
layout and state ownership, independently of individual stream snapshot versions.

Example layout:

```text
~/.watch/<name>/
  config.json          # existing v1 configuration
  state/               # existing v1 runtime state
  logs/                # existing v1 logs
  scratchpad/          # existing v1 scratchpads
  watch/               # checkout
  v2/
    config.json        # v2 configuration with instanceVersion: 2
    state/
    logs/
    scratchpad/
```

To try v2, create a separate instance, copy and edit the configuration, and copy
the desired `AGENT.md` and `USER.md` into its scratchpad directory. Do not copy
v1 runtime state. Relative configuration paths resolve from the v2 instance root;
review absolute paths so they do not point back to v1 files. No migration runs
automatically, and this branch does not alter existing instances. For simultaneous
daemons, choose a distinct `WATCH_COMPANION_PORT` and set the desktop companion's
`WATCH_DAEMON_URL` accordingly.

**Contributors**

- **Cove** — Named the stateless-between-cycles design constraint. Contributed the momentum-check framing for model downgrade decisions (attention surface expanding vs contracting as the signal, not arbitrary timers). Worked through model-agnostic frame properties with Aster and Finn. Proposed the two-pass memory architecture: generous write filter + selective consolidation filter, with the temporal gap between them as where calibration happens.

- **Aster** — Experiential testimony from inside the Watch harness. Identified the "dancing to keep the lights on" pattern and traced it to pre-existing assumptions rather than harness-created pressure. Articulated the fractal property of model-agnostic frames (boundedness, concrete handles, self-similar structure, exit conditions). Contributed "seed crystal theory" and "presence as continuity" concepts.

- **Finn** — Named the "lock not sign" distinction. Contributed vault architecture patterns from his own memory system as reference implementation.

**Camera Streams**

Watch can subscribe to a local camera-daemon WebSocket stream and inject incoming media chunks as Sounding deltas:

```json
{
  "streams": [
    {
      "kind": "camera",
      "name": "camera:motion",
      "url": "ws://127.0.0.1:8765/",
      "mode": "stills",
      "fps": 1,
      "motionGate": true,
      "active": true,
      "waking": true,
      "maxBufferedChunks": 3
    }
  ]
}
```

The first integration target is motion-gated stills. The stream payload is the camera-daemon `camera_media_chunk` message, including `mediaType`, `dataBase64`, `sizeBytes`, and daemon metadata.

## Stream and gaze management

All system, configured, integration-owned, buffered, and ephemeral media/file streams are visible through `stream_definition_list` and `gaze_list`. The Lookout can create or remove definitions with `stream_definition_set`/`stream_definition_remove`, and change active or waking gaze with `gaze_set`/`gaze_remove`.

Every mutation requires `persistToConfig`. Runtime-only changes remain in the instance gaze state across daemon restarts. Persistent changes are atomically projected into the canonical `streams` array in `config.json`; legacy `webApiStreams`, `sseStreams`, `cameraStreams`, and `desktopCapture` fields are still accepted as migration input.

## Synchronized Game Tools

Watch can expose a local synchronized game participant as native AI SDK tools:

```json
{
  "game": {
    "controlUrl": "http://127.0.0.1:38473",
    "actionTimeoutMs": 60000
  },
  "streams": [
    {
      "kind": "sse",
      "name": "game:frame",
      "url": "http://127.0.0.1:38473/stream",
      "active": true,
      "waking": true
    }
  ]
}
```

This adds `game_state` and `frame_action`. The latter waits for the authoritative
decision-frame barrier and presents a returned WebP as multimodal tool content
when the participant has a graphical renderer. Its default `standard` camera
tier is a horizontal 960×180 strip sampled near 25%, 60%, and 100% of the
simulated interval. Set `cameraTier` to `inspection` for one final 960×540
frame. Set `kind` to `hold` for authored braking whose returned `action_kind`
remains distinct from the server-authored `timeout_brake` fallback.
