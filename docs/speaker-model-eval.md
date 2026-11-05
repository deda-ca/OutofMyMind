# Speaker-model evaluation (M1)

Date: 2026-11-05. Tool: [tools/speaker-eval](../tools/speaker-eval/README.md). Design: [speaker-recognition.md](speaker-recognition.md).

## Decision

**3D-Speaker CAM++**, run with ONNX Runtime and our own Kaldi-style features, threshold **0.43**. It tied for the most accurate model, was among the fastest, holds up in noise, and isn't affected by Jarvis's Opus archive format.

## Setup

- **Data:** LibriSpeech test-clean (CC BY 4.0), 40 speakers × 10 utterances (4–15 s, spread across recording sessions), 58 minutes. Clean read speech: easy compared with real use, so this checks correctness and speed more than real-world accuracy.
- **Models:** six English speaker-embedding models from sherpa-onnx's release, checksum-verified.
- **Runtime:** ONNX Runtime (CPU, one thread) with features computed in TypeScript (`apps/server/src/speaker/features.ts`), on an AMD Ryzen 9 5950X.
- **Conditions:** whole phrase (up to 10 s); first 3 s; first 1.5 s (Jarvis's early guess); whole phrase after Opus 32 kbps encoding and decoding (the archive); car-like rumble mixed in 10 dB below the voice; three other people talking 15 dB below (TV / background talk).

Metrics (details in the tool README):
- **EER:** equal error rate over all same- and different-speaker pairs (1,800 and 78,000). Lower is better.
- **Owner@1%:** each speaker in turn is "the owner", enrolled with 3 clips; share of their other phrases recognised while at most 1% of everyone else's are let through.
- **Threshold:** the cosine similarity giving owner@1%.

## Results: accuracy and speed

| Model | EER whole | EER first 3 s | EER first 1.5 s | Owner@1%, first 1.5 s | EER after Opus | Threshold (owner@1%) | ms / phrase | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **3D-Speaker CAM++** | **0.1%** | 1.0% | 4.4% | 97.9% | 0.2% | 0.43 | 133 | 28 MB |
| WeSpeaker CAM++-LM | 0.2% | 1.4% | 4.8% | 98.2% | 0.2% | 0.44 | 129 | 28 MB |
| WeSpeaker ResNet34-LM | 0.2% | 1.4% | 3.8% | 98.6% | 0.2% | 0.41 | 300 | 25 MB |
| 3D-Speaker ERes2Net | 0.3% | 1.3% | 4.0% | 98.2% | 0.4% | 0.40 | 309 | 25 MB |
| NeMo TitaNet large | 0.6% | 0.8% | **2.5%** | **99.3%** | 0.6% | 0.36 | 303 | 97 MB |
| NeMo TitaNet small | 0.8% | 1.2% | 2.5% | 96.8% | 0.9% | 0.37 | 113 | 38 MB |

Owner recognition from whole phrases was 99–100% for every model.

## Results: noise

| Model | EER, car noise 10 dB | EER, background talk 15 dB | Threshold (owner@1%) car / talk |
| --- | --- | --- | --- |
| **3D-Speaker CAM++** | 0.2% | 0.5% | 0.42 / 0.43 |
| WeSpeaker ResNet34-LM | 0.2% | 0.4% | 0.41 / 0.40 |
| NeMo TitaNet large | 0.6% | 0.6% | 0.36 / 0.34 |

## What it means

- **All the Kaldi-feature models are close** on clean whole phrases; speed and size decide. CAM++ (either version) is ~2.3× faster than ResNet34 / ERes2Net.
- **Noise costs little at these levels** for every model (EER ≤ 0.6%); background talk is the harder of the two, as expected.
- **CAM++'s threshold is stable** (0.42–0.43 for clean, Opus, car noise and background talk), so one default works.
- **The early guess (first 1.5 s) is weaker** (~98% of the owner's phrases recognised at 1% false accepts). That's fine for a provisional tag; the final decision uses the whole phrase. TitaNet large is the best early-guesser (99.3%) at 2.3× the cost and 3.4× the size: a candidate for the early guess only, if real use shows it's needed.
- **Opus 32 kbps barely matters** (CAM++ 0.1% → 0.2% EER), so archived audio is good for recomputing voiceprints and for training.
- **LibriSpeech is easy.** Real conditions (your devices, rooms, Bluetooth, conversation) will be harder. The threshold is a starting point: tune it with the Monitor's "Voice match" bar and the Settings slider, and re-measure once there are real recordings of you and others.

## Grouping unknown voices (M3)

Tool: `tools/speaker-eval/src/grouping-eval.ts`. It replays the server's grouping rule on the same 40 speakers: one is the owner (3 enrolled clips), the 400 phrases arrive in a shuffled order (5 orders averaged), each is the owner, joins the best-matching group, or starts a new one.

| Phrases | Rule | Groups per person (ideal 1.00) | Phrases in someone else's group | Owner missed | Others taken for the owner |
| --- | --- | --- | --- | --- | --- |
| Whole (4–10 s) | **mean of 3 closest clips ≥ 0.45, learn ≥ 0.55** | 1.07 | 1.2% | 0% | 0.9% |
| Short (1.5–6 s) | same | 1.07 | 0.2% | 0% | 0.6% |
| Short + background talk 15 dB | same | 1.30 | 0.6% | 0% | 0.7% |
| Short + background talk 15 dB | best single clip ≥ 0.40, no learn margin | 1.09 | 14.7% | 0% | 0.7% |

- A **low** join threshold merges different people; a **high** one splits a person into several groups. Splits are cheaper to fix (one "combine") than mixed groups (phrase-by-phrase corrections), so the rule leans towards splitting.
- Averaging the 3 closest clips beats the single best clip (fewer wrong merges at the same split rate).
- Learning only from clear matches (≥ 0.55, ≥ 2 s of speech) keeps libraries clean.
- Groups whose voices score ≥ 0.35 against each other are shown as "might be the same person" so splits are easy to spot and combine.

## Speaker changes inside a phrase (M4)

People taking turns without a pause end up in one phrase. Tool: `tools/speaker-eval/src/change-eval.ts`; code: `apps/server/src/speaker/changes.ts`.

**Test set:** 60 conversations built from LibriSpeech, 2–4 people taking 3–6 turns of 1.5–8 s with silence trimmed and 0–0.15 s between turns, up to 25 s (185 speaker changes, 18 min), plus 30 single-speaker phrases. Every speaker enrolled with 3 clips not used in the test; each piece identified among all 40.

**Method:** compare a voiceprint of the window before each point (every 0.25 s) with the window after it; split at clear dips; re-join neighbouring pieces that still sound alike; snap cuts to the quietest moment within ±0.25 s; fold pieces under 1.5 s into the neighbour they sound more like.

| Setting | Speech time credited to the right person | Changes found (±0.5 s) | Wrong cuts | False splits per single-speaker phrase |
| --- | --- | --- | --- | --- |
| No splitting (before M4) | 52.5% | – | – | – |
| 1 s windows, split < 0.3, re-join ≥ 0.4 | 95.9% | 90.8% | 85 | 0.23 |
| **1.5 s windows, split < 0.3, re-join ≥ 0.4** (chosen, before folding short pieces) | 97.0% | 89.2% | 40 | 0 |
| **… plus folding pieces under 1.5 s** (final) | **96.8%** | 88.6% | **23** | **0** |
| 2 s windows, split < 0.4, re-join ≥ 0.4 | 97.1% | 89.2% | 38 | 0 |
| 1.5 s windows, split < 0.5, no re-join | 96.7% | 89.2% | 198 | 4.70 |

- **Re-joining is what matters:** without it, one person's speech is chopped up (up to 12 false splits per phrase); with it, the split threshold barely matters between 0.3 and 0.6.
- **Folding short pieces** removed blends at boundaries (which otherwise matched nobody and created a stray "Speaker X"); in a browser test a no-pause You → Bob → Speaker B → You conversation came out exactly right.
- **Cost:** ~1.4–1.8 s of CPU per 18 s phrase (shorter phrases less), so split text appears a little after the phrase ends. Phrases under 3 s aren't scanned.
- **Not covered:** people talking at the same time (needs a diarization model such as audio.cpp's Sortformer), and turns under ~1.5 s.

Full sweep: `tools/speaker-eval/results-changes-sweep.txt`.

## Why not sherpa-onnx

The design originally picked sherpa-onnx (`sherpa-onnx-node`) to run these models. On this machine its voiceprints were wrong, with both 2.0.1 and 1.13.8:

| Check | Result |
| --- | --- |
| CAM++ EER on the same LibriSpeech set, via sherpa-onnx | 26.8% (ONNX Runtime + our features: 0.1%) |
| Same clip, sherpa-onnx vs reference voiceprint, by clip length | cosine 0.87 at 2 s, 0.11 at 5 s and 8 s |
| sherpa-onnx's own example recordings, WeSpeaker ResNet34 | every voice 0.67–0.93 similar to every other |
| Thread count, input scaling, `inputFinished()` | no change |

The data, models and CPU were ruled out (the same model files work through ONNX Runtime), so the fault is in its feature pipeline. Not investigated further; ONNX Runtime with our own features is simpler anyway, and it also runs on Android.
