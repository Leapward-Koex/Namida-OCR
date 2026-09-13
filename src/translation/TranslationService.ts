import { getTranslatorApi, type TranslatorFactory, type TranslatorSession } from './TranslatorApi';
import { normalizeTranslationTarget } from './TranslationLanguages';
import { prepareTranslationInput } from './TranslationInput';
import type { TranslationRequest, TranslationResult, TranslationStatus } from './TranslationTypes';

interface PendingTranslation {
    controller: AbortController;
    timedOut: boolean;
}

const unsupported = {
    ok: false, reason: 'unsupported', message: 'Local translation is unavailable in this browser',
} as const satisfies TranslationResult;

// Owned by the offscreen document. OCR has an independent lifecycle and queue.
export class TranslationService {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly pending = new Map<string, PendingTranslation>();
    private session: { targetLanguage: string; translator: TranslatorSession } | null = null;
    private active: PendingTranslation | null = null;

    constructor(
        private readonly apiProvider: () => TranslatorFactory | null = getTranslatorApi,
        private readonly deadlineMs = 60_000,
    ) {}

    async getStatus(targetLanguage: string): Promise<TranslationStatus> {
        const api = this.apiProvider();
        if (!api) return { state: 'unsupported', message: unsupported.message };
        try {
            const state = await api.availability({ sourceLanguage: 'ja', targetLanguage: normalizeTranslationTarget(targetLanguage) });
            if (!['unavailable', 'downloadable', 'downloading', 'available'].includes(state)) {
                return { state: 'error', message: 'The browser returned an unknown translation availability state.' };
            }
            return { state };
        } catch {
            return { state: 'error', message: 'Could not check local translation availability. Try again in settings.' };
        }
    }

    translate(request: TranslationRequest): Promise<TranslationResult> {
        if (!request.text.trim()) return Promise.resolve({ ok: true, text: '' });
        this.cancel(request.requestId);
        const pending: PendingTranslation = { controller: new AbortController(), timedOut: false };
        this.pending.set(request.requestId, pending);
        const timer = setTimeout(() => {
            pending.timedOut = true;
            this.abort(pending);
        }, this.deadlineMs);
        const queued = this.queue.then(async () => {
            if (pending.controller.signal.aborted) return this.abortResult(pending);
            this.active = pending;
            try {
                return await this.run(request, pending);
            } catch {
                this.destroySession();
                return pending.controller.signal.aborted
                    ? this.abortResult(pending)
                    : { ok: false, reason: 'error', message: 'Local translation failed. Try again or check translation settings.' } as const;
            } finally {
                this.active = null;
            }
        });
        this.queue = queued.catch(() => {});
        // The deadline includes queue time, even if a preceding browser API hangs.
        return this.interruptible(queued, pending.controller.signal)
            .catch(() => this.abortResult(pending))
            .finally(() => {
                clearTimeout(timer);
                if (this.pending.get(request.requestId) === pending) this.pending.delete(request.requestId);
            });
    }

    cancel(requestId: string): void {
        const pending = this.pending.get(requestId);
        if (pending) this.abort(pending);
    }

    reset(): void {
        for (const pending of this.pending.values()) this.abort(pending);
        this.destroySession();
    }

    private async run(request: TranslationRequest, pending: PendingTranslation): Promise<TranslationResult> {
        const api = this.apiProvider();
        if (!api) return unsupported;
        const targetLanguage = normalizeTranslationTarget(request.targetLanguage);
        const signal = pending.controller.signal;
        const status = await this.interruptible(this.getStatus(targetLanguage), signal);
        if (status.state === 'unsupported') return unsupported;
        if (status.state === 'unavailable') return { ok: false, reason: 'unavailable', message: 'This browser does not support the selected translation language pair.' };
        if (status.state === 'downloadable' || status.state === 'downloading') {
            return { ok: false, reason: 'setup-required', message: 'Set up this language in translation settings before translating.' };
        }
        if (status.state !== 'available') return { ok: false, reason: 'error', message: status.message ?? 'Could not check translation availability.' };
        if (this.session?.targetLanguage !== targetLanguage) this.destroySession();
        if (!this.session) {
            // Never create a downloadable pair here: only the visible setup click
            // may authorize a browser-managed model download.
            const creating = api.create({ sourceLanguage: 'ja', targetLanguage, signal });
            creating.then((translator) => {
                if (signal.aborted) {
                    try { translator.destroy(); } catch { /* Already disposed by the browser. */ }
                }
            }, () => {});
            const translator = await this.interruptible(creating, signal);
            if (signal.aborted) return this.abortResult(pending);
            this.session = { targetLanguage, translator };
        }
        const text = await this.interruptible(this.session.translator.translate(prepareTranslationInput(request.text), { signal }), signal);
        if (signal.aborted) return this.abortResult(pending);
        return { ok: true, text };
    }

    private abort(pending: PendingTranslation): void {
        pending.controller.abort();
        if (this.active === pending) this.destroySession();
    }

    private abortResult(pending: PendingTranslation): TranslationResult {
        return pending.timedOut
            ? { ok: false, reason: 'timeout', message: 'Local translation took too long. Try again.' }
            : { ok: false, reason: 'cancelled', message: 'Translation cancelled.' };
    }

    private destroySession(): void {
        const previous = this.session;
        this.session = null;
        try { previous?.translator.destroy(); } catch { /* A destroyed browser session may already be gone. */ }
    }

    private interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(new Error('Translation cancelled'));
            if (signal.aborted) {
                operation.catch(() => {});
                abort();
                return;
            }
            signal.addEventListener('abort', abort, { once: true });
            operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
}
