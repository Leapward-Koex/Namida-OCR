import { createWorker, OEM, PSM, Worker } from 'tesseract.js';
import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction } from '../interfaces/message';
import { Settings } from '../interfaces/Storage';

export class TesseractOcrHandler {
  private static logTag = `[${TesseractOcrHandler.name}]`;
  private static worker: Worker | null = null;
  private static workerPromise: Promise<Worker> | null;

  public static async initWorker(): Promise<void> {
    if (TesseractOcrHandler.workerPromise) {
      // Already initialized or in the process of initializing, so just return.
      return;
    }

    const languages = ['jpn_vert'];

    console.debug(TesseractOcrHandler.logTag, "Creating OCR worker");
    try {
      TesseractOcrHandler.workerPromise = createWorker(
        languages,
        OEM.LSTM_ONLY,
        {
          workerBlobURL: false,
          corePath: '/libs/tesseract-core',
          workerPath: '/libs/tesseract-worker/worker.min.js',
          langPath: '/libs/tesseract-lang',
          gzip: false, // Edge extension validation does not allow files that end with .gz https://github.com/microsoft/MicrosoftEdge-Extensions/discussions/135
          logger: (m) => console.log(m)
        }
      );

      TesseractOcrHandler.worker = await TesseractOcrHandler.workerPromise;

      console.debug(TesseractOcrHandler.logTag, "Created OCR worker");
    } catch (error) {
      console.error(TesseractOcrHandler.logTag, "Error initializing OCR worker", error);
      TesseractOcrHandler.workerPromise = null;
      TesseractOcrHandler.worker = null;
    } finally {
    }
  }

  /// This is the only function that must be called from the content
  public async recognizeFromContent(dataUrl: string): Promise<string> {
    const text = await runtime.sendMessage({ action: NamidaMessageAction.RecognizeImage, data: dataUrl }) as string;
    console.debug(TesseractOcrHandler.logTag, "Recognized text: " + text);
    return text;
  }

  public static async recognizeFromOffscreen(dataUrl: string, pageSegMode: PSM): Promise<string | undefined> {
    if (!TesseractOcrHandler.workerPromise) {
      console.error(TesseractOcrHandler.logTag, 'OCR worker not ready. Did you call initWorker()?');
      return undefined;
    }

    try {
      await TesseractOcrHandler.workerPromise;
      await TesseractOcrHandler.worker!.setParameters({
        tessedit_pageseg_mode: pageSegMode,
      });
      console.debug(TesseractOcrHandler.logTag, "Trying to recognize text using pagesegmode:", pageSegMode);
      const recognizeResult = await TesseractOcrHandler.worker!.recognize(dataUrl);
      console.debug(TesseractOcrHandler.logTag, "Recognize result:", recognizeResult.data);
      return recognizeResult.data.text;
    } catch (ex) {
      console.error(TesseractOcrHandler.logTag, "Error recognizing text", ex);
    }
    return undefined;
  }

  public static async terminate() {
    if (TesseractOcrHandler.worker) {
      await TesseractOcrHandler.worker.terminate();
      TesseractOcrHandler.worker = null;
      TesseractOcrHandler.workerPromise = null;
    }
  }
}
