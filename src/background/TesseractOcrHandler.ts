import { createWorker, OEM, Worker } from 'tesseract.js';
import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction } from '../interfaces/message';

export class TesseractOcrHandler {
  private static worker: Worker | null = null;
  private static initializing: boolean = false;
  private static initialized: boolean = false;

  public static async initWorker(languages = ['jpn', 'eng']): Promise<void> {
    if (TesseractOcrHandler.initialized || TesseractOcrHandler.initializing) {
      // Already initialized or in the process of initializing, so just return.
      return;
    }
    TesseractOcrHandler.initializing = true;

    console.debug("Creating OCR worker");
    try {
      TesseractOcrHandler.worker = await createWorker(
        languages,
        OEM.DEFAULT,
        {
          workerBlobURL: false,
          corePath: '/libs/tesseract-core',
          workerPath: '/libs/tesseract-worker/worker.min.js',
          langPath: '/libs/tesseract-lang',
          logger: (m) => console.log(m)
        }
      );

      console.debug("Created OCR worker");
      TesseractOcrHandler.initialized = true;
    } catch (error) {
      console.error("Error initializing OCR worker", error);
      TesseractOcrHandler.worker = null;
    } finally {
      TesseractOcrHandler.initializing = false;
    }
  }

  /// This is the only function that must be called from the content
  public async recognizeFromContent(dataUrl: string): Promise<string> {
    const text = await runtime.sendMessage({ action: NamidaMessageAction.RecognizeImage, data: dataUrl }) as string;
    console.debug("Recognized text: " + text);
    return text;
  }

  public static async recognizeFromBackground(dataUrl: string): Promise<string | undefined> {
    if (!TesseractOcrHandler.initialized || !TesseractOcrHandler.worker) {
      console.error('OCR worker not ready. Did you call initWorker()?');
      return undefined;
    }

    try {
      // Reuse the same worker instance
      const { data: { text } } = await TesseractOcrHandler.worker.recognize(dataUrl);
      console.debug("Recognized text:", text);
      return text;
    } catch (ex) {
      console.error("Error recognizing text", ex);
    }
    return undefined;
  }

  public static async terminate() {
    if (TesseractOcrHandler.worker) {
      await TesseractOcrHandler.worker.terminate();
      TesseractOcrHandler.worker = null;
      TesseractOcrHandler.initialized = false;
    }
  }
}
