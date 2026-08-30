# PhantomTower local vision models

This directory is packaged as `resources/vision-models` in the Electron build.

The automatic mask pipeline expects a compatible ONNX bundle with these files:

- `person-detector.onnx` (or `yolov8n.onnx`): a COCO-style detector whose
  class 0 is person and whose output is `[1,84,N]` or `[1,N,84]`.
- `sam2-encoder.onnx` (or `image_encoder.onnx`): SAM 2 image encoder.
- `sam2-decoder.onnx` (or `image_decoder.onnx` / `decoder.onnx`): SAM 2 prompt
  decoder with the standard box-prompt inputs and mask output.

The bundled Tiny weights are exported from
`shubham0204/sam2-onnx-models` (SAM2 Hiera Tiny, Apache-2.0):
`sam2_hiera_tiny_encoder.onnx` and `sam2_hiera_tiny_decoder.onnx`.

The model files are packaged with the app and are not downloaded at runtime.
If they are missing or incompatible, the app reports
`VISION_MODELS_NOT_INSTALLED` and falls back to the existing generation path
without sending a guessed mask.
