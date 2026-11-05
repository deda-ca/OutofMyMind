# Speaker-model evaluation

Compares speaker-embedding (voiceprint) models for Jarvis's speaker recognition (design: [../../docs/speaker-recognition.md](../../docs/speaker-recognition.md), milestone M1). Results: [../../docs/speaker-model-eval.md](../../docs/speaker-model-eval.md).

Everything runs locally on the CPU with [ONNX Runtime](https://onnxruntime.ai/) (`onnxruntime-node`, MIT). Audio features are computed in TypeScript (`src/features.ts`), the same way the models were trained.

```bash
npm install
node src/fetch-models.ts            # ~240 MB of models into models/, checksum-verified
node src/fetch-librispeech.ts 10    # 40 speakers × 10 utterances of LibriSpeech test-clean into data/
node src/eval.ts                    # all models; or --models=cam++,titanet ; writes results.json
npx tsc --noEmit
```

`models/` and `data/` are git-ignored.

## What it measures

For each model and audio condition (whole phrase up to 10 s, first 3 s, first 1.5 s, whole phrase after Jarvis's Opus archive encoding):

| Metric | Meaning |
| --- | --- |
| **EER** | Equal error rate over every same-speaker and different-speaker pair: how often it confuses two people at its best threshold. Lower is better. |
| **owner@1%FA** | Jarvis's case. Each speaker in turn is the "owner", enrolled with 3 clean clips; a phrase scores its best match among them. Share of the owner's other phrases recognised when at most 1% of everyone else's are let through. |
| **owner EER** | EER of that owner scenario. |
| **ident** | Closed-set identification: which of the N enrolled speakers is this? |
| **thresholds** | Cosine similarity cut-offs at the EER and at owner@1%FA. |
| **ms/phrase, RTF** | Feature extraction + model, one CPU thread. RTF = processing time / audio duration. |

## Files

| File | |
| --- | --- |
| `src/features.ts` | Kaldi fbank (3D-Speaker, WeSpeaker) and NeMo mel (TitaNet) features |
| `src/voiceprint.ts` | Loads an ONNX model and computes normalised voiceprints |
| `src/models.ts` | The models compared |
| `src/eval.ts` | The evaluation |
| `src/fetch-models.ts`, `src/fetch-librispeech.ts` | Downloads |
| `src/wav.ts` | 16-bit mono WAV read/write |

## Why not sherpa-onnx

The first version used `sherpa-onnx-node` (versions 2.0.1 and 1.13.8 both tested). On this machine its voiceprints were wrong: 27% EER for CAM++ on LibriSpeech, and its output for the same clip disagreed erratically with a reference computation (cosine 0.87 at 2 s, 0.11 at 8 s). The same model files run through ONNX Runtime with our own features give 0.1% EER. The fault is somewhere in its feature pipeline; we didn't dig further.
