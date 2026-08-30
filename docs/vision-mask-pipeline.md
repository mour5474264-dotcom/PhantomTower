# Automatic person masks

PhantomTower keeps the existing Node local service. During batch replacement the
renderer sends each target image to `/api/vision/mask`; the service is responsible
for loading the bundled ONNX detector and SAM 2 encoder/decoder, then returning a
same-size PNG mask. The renderer reuses that mask for every copy of the target
task.

The Electron build places model resources in `resources/vision-models`. The
bundle must contain:

- `person-detector.onnx` (the repository includes a COCO YOLO11n model under
  the accepted `yolov8n.onnx` alias)
- `sam2-encoder.onnx`
- `sam2-decoder.onnx`

`onnxruntime-node` is loaded from the packaged app resources and attempts
DirectML before CPU. If the model bundle is unavailable or incompatible, the
service returns a structured error and the batch request continues without a
guessed mask. This is intentional: a wrong mask can erase the background.

The mask is appended as `mask` in the OpenAI Images multipart edit request. Native
Gemini/Nano Banana requests continue to receive the reference images through the
existing `generateContent` path because that API does not define an equivalent
mask field.
