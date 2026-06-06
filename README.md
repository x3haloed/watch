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
