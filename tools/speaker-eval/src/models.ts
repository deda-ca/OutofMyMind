// The speaker-embedding models being compared (all from sherpa-onnx's release).

export interface ModelInfo {
  /** Short name for tables. */
  name: string
  file: string
  origin: string
}

export const MODELS: ModelInfo[] = [
  { name: '3D-Speaker CAM++', file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx', origin: 'Alibaba 3D-Speaker, VoxCeleb' },
  { name: '3D-Speaker ERes2Net', file: '3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx', origin: 'Alibaba 3D-Speaker, VoxCeleb' },
  { name: 'WeSpeaker ResNet34-LM', file: 'wespeaker_en_voxceleb_resnet34_LM.onnx', origin: 'WeSpeaker, VoxCeleb' },
  { name: 'WeSpeaker CAM++-LM', file: 'wespeaker_en_voxceleb_CAM++_LM.onnx', origin: 'WeSpeaker, VoxCeleb' },
  { name: 'NeMo TitaNet small', file: 'nemo_en_titanet_small.onnx', origin: 'NVIDIA NeMo' },
  { name: 'NeMo TitaNet large', file: 'nemo_en_titanet_large.onnx', origin: 'NVIDIA NeMo' },
]
