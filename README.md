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
  "cameraStreams": [
    {
      "name": "camera:motion",
      "url": "ws://127.0.0.1:8765/",
      "mode": "stills",
      "fps": 1,
      "motionGate": true,
      "subscribed": true,
      "waking": true,
      "maxBufferedChunks": 3
    }
  ]
}
```

The first integration target is motion-gated stills. The stream payload is the camera-daemon `camera_media_chunk` message, including `mediaType`, `dataBase64`, `sizeBytes`, and daemon metadata.

## Synchronized Game Tools

Watch can expose a local synchronized game participant as native AI SDK tools:

```json
{
  "game": {
    "controlUrl": "http://127.0.0.1:38473",
    "actionTimeoutMs": 45000
  },
  "sseStreams": [
    {
      "name": "game:frame",
      "url": "http://127.0.0.1:38473/stream",
      "subscribed": true,
      "waking": true
    }
  ]
}
```

This adds `game_state` and `frame_action`. The latter waits for the authoritative
decision-frame barrier and presents a returned camera PNG as multimodal tool
content when the participant has a graphical renderer.
