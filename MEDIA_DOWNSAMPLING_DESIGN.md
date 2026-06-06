# Media Downsampling Design

## Purpose

Watch should support continuous multimodal experience across Soundings without
letting raw media overwhelm the conversation history. The model should receive
full-fidelity media while a Sounding is active, but canonical history should
store downsampled media once that Sounding is committed.

## Core Policy

1. Active Sounding inference receives exact media.
2. When completed Sounding messages are merged into canonical conversation
   history, every media attachment is downsampled immediately.
3. Canonical history stores downsampled media as the source of truth.
4. Before inference on a model that lacks a required media modality, Watch
   clones canonical history and replaces unsupported media with text
   placeholders.
5. Model-specific placeholder replacement must never mutate canonical history.

This means exact media is momentary, downsampled media is durable, and
unsupported-model stripping is only an inference-view transformation.

## Why

Replacing media with a placeholder preserves context window space but leaves a
hole where the agent previously had real perceptual context. Preserving exact
media forever preserves experience but eventually breaks context and provider
limits. Immediate downsampling is the compromise: the agent keeps a real
perceptual trace, but history stays much cheaper than the active Sounding.

## Current State

Watch can attach media to the current model call through `open_media`.

The desired current minimum behavior is:

- preserve media in canonical history;
- strip unsupported media only from the cloned inference input for models that
  cannot consume that media type.

The next major step is replacing exact canonical preservation with canonical
downsampling.

## Downsampling By Modality

### Images

First pass:

- decode the original image;
- downscale dimensions to a fixed maximum width/height;
- encode as compressed JPEG;
- strip metadata.

Open questions:

- exact max dimension;
- JPEG quality setting;
- whether transparent images should become JPEG with a background or remain PNG.

### Video

First pass:

- lower resolution;
- lower frame rate;
- encode as MP4.

For camera-daemon streams, continuous video chunks should remain sequential
segments after downsampling. Segment metadata such as frame sequence and segment
boundaries can stay in surrounding JSON/text, but the media payload itself should
be downsampled.

Open questions:

- target width/height;
- target FPS;
- bitrate or CRF target;
- whether very short segments need special handling.

### Audio

First pass:

- lower sample rate;
- likely mono;
- encode with a compact audio codec.

Open questions:

- target sample rate;
- codec choice;
- whether to preserve stereo for some sources.

### PDF

Unresolved.

Possible approaches:

- leave PDFs unchanged initially;
- re-export at lower fidelity, roughly like print quality to web quality;
- render lower-resolution page images;
- extract text and preserve a reduced visual representation.

PDF downsampling should be treated as a separate design decision.

### Generic Files

No downsampling strategy for arbitrary files. Unsupported generic files should
remain metadata-only unless a specific file family gets its own policy.

## Suggested Tooling

Prefer a single external media backend for the first implementation:

- `ffmpeg` for video;
- `ffmpeg` for audio;
- possibly `ffmpeg` for image downsampling too, to avoid adding multiple native
  Node dependencies.

A later implementation may choose a dedicated image library if it materially
improves quality or reliability.

## Watch Integration Points

The likely integration point is the history commit path in `src/lookout.ts`.

Current places to revisit:

- `sanitizeMessagesForHistory(...)`
- `mediaToolOutputToModelOutput(...)`
- `messagesForModel(...)`
- `agent.generate({ messages: ... })`

Desired future shape:

- `downsampleMessagesForHistory(messages)` for canonical history commit;
- `messagesForModel(model, canonicalMessages)` for model-specific inference
  views;
- token estimation should eventually use a compact model-specific view rather
  than raw base64 media.

## Non-Goals

- Do not downsample media before the active Sounding inference.
- Do not replace canonical media with plain placeholders.
- Do not build accumulation/replay logic until downsampled canonical media has
  been tested.
- Do not solve PDF downsampling in the first pass unless it becomes blocking.

## Known Risk

Token estimation will be wrong or noisy while canonical history contains media
payloads. That is acceptable temporarily. A later pass should estimate context
against a model-specific compact view.
