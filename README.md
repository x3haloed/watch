## Seed crystals

Watch can preserve scarce, agent-authored activation language across reentry. Enable it with
`memory.seedCrystals.enabled` in the instance `config.json`. Crystals begin as candidates by
default and move through explicit, judgment-only lifecycle transitions. Active crystals are
injected into every model turn in a data-only safety envelope with authorship, evidence, and
byte-budget validation.

The model receives `seed_crystal_create`, `seed_crystal_list`, `seed_crystal_expand`, `seed_crystal_revise`,
`seed_crystal_observe_activation`, and `seed_crystal_transition` alongside the existing memory
tools. Facts, tasks, user instructions, and merely attractive summaries belong in ordinary
memory rather than seed crystals.

## Instance Layout

Watch now expects to run from inside a bare clone at `~/.watch/<name>/watch/`.
The parent directory is the instance root and must contain `config.json`.

Example layout:

```text
~/.watch/<name>/
  config.json
  state/
  logs/
  scratchpad/
  watch/
```

Relative paths in `config.json` resolve from the instance root.

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
