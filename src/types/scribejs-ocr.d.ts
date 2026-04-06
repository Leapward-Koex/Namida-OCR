declare module 'scribe.js-ocr/tess/TessWorker.js' {
    type TessLoggerMessage = {
        jobId?: string;
        progress?: number;
        status?: string;
        userJobId?: string;
        workerId?: string;
    };

    export type TessRecognizeResult = {
        jobId?: string;
        data: {
            blocks?: unknown[] | null;
            confidence?: number | null;
            symbols?: Array<{ confidence: number }>;
            text?: string | null;
        };
    };

    export class TessWorker {
        static OEM: {
            LSTM_ONLY: number;
        };

        static PSM: Record<string, string>;

        static create(
            langs?: string | string[],
            oem?: number,
            options?: {
                errorHandler?: (error: unknown) => void;
                gzip?: boolean;
                langPath?: string;
                legacyCore?: boolean;
                legacyLang?: boolean;
                logger?: (message: TessLoggerMessage) => void;
            },
            config?: Record<string, string>,
        ): Promise<TessWorker>;

        setParameters(params?: Record<string, string | number>): Promise<unknown>;
        recognize(
            image: string | Blob,
            options?: Record<string, unknown>,
            output?: Record<string, boolean>,
        ): Promise<TessRecognizeResult>;
        terminate(): Promise<unknown>;
    }
}
