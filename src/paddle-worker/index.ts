import * as ort from 'onnxruntime-web';
import { installPaddleWorker, PaddleWorkerScope } from './worker';

// This entry point intentionally owns a separate ORT module instance and GPU device.
installPaddleWorker(globalThis as unknown as PaddleWorkerScope, ort);
