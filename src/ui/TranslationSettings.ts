import { runtime, storage } from 'webextension-polyfill';
import { Settings, StorageKey } from '../interfaces/Storage';
import { NamidaMessageAction } from '../interfaces/message';
import { TRANSLATION_LANGUAGES, normalizeTranslationTarget } from '../translation/TranslationLanguages';
import { getTranslatorApi, isTranslationPlatformSupported } from '../translation/TranslatorApi';
import type { TranslationStatus } from '../translation/TranslationTypes';

type SettingsStatus = TranslationStatus | { state: 'checking'; message?: string };

/** Model setup lives in the visible document so create() keeps the user's activation. */
export function initializeTranslationSettings(): void {
    const section = document.getElementById('translation');
    if (!section || !isTranslationPlatformSupported()) return;
    section.hidden = false;
    const enabled = document.getElementById('translation-enabled') as HTMLInputElement;
    const target = document.getElementById('translation-target-language') as HTMLSelectElement;
    const statusText = document.getElementById('translation-status') as HTMLParagraphElement;
    const progress = document.getElementById('translation-download-progress') as HTMLProgressElement;
    const setup = document.getElementById('translation-setup') as HTMLButtonElement;
    const cancel = document.getElementById('translation-cancel-setup') as HTMLButtonElement;
    let revision = 0;
    let disposed = false;
    let setupController: AbortController | null = null;
    let settingsLoaded = false;
    let enabledPreference: boolean | undefined;
    const initialChanges: { enabled?: boolean; targetLanguage?: string } = {};
    let status: SettingsStatus = { state: 'checking' };

    for (const language of TRANSLATION_LANGUAGES) {
        const option = document.createElement('option');
        option.value = language.code;
        option.textContent = language.label;
        target.appendChild(option);
    }
    target.value = 'en';

    // This is deliberately the documented feature check, in the settings document itself.
    const api = 'Translator' in self ? getTranslatorApi() : null;

    function render(next: SettingsStatus): void {
        status = next;
        enabled.checked = enabledPreference ?? next.state === 'available';
        const busy = next.state === 'checking' || setupController !== null;
        const unsupported = !api || next.state === 'unsupported';
        enabled.disabled = unsupported || !settingsLoaded || busy || next.state === 'unavailable';
        target.disabled = unsupported || !settingsLoaded;
        setup.disabled = unsupported || !settingsLoaded || busy || next.state === 'unavailable' || next.state === 'available';
        setup.hidden = setup.disabled;
        setup.textContent = next.state === 'downloading' ? 'Finish setup' : 'Download & enable';
        progress.hidden = setupController === null;
        cancel.hidden = setupController === null;
        const descriptions: Record<SettingsStatus['state'], string> = {
            checking: 'Checking availability…',
            unsupported: 'Local translation is unavailable in this browser',
            unavailable: 'This language is unavailable. Choose another language.',
            downloadable: 'Download the language files to translate on this device.',
            downloading: 'Finish downloading the language files to translate on this device.',
            available: 'Ready for offline translation.',
            error: 'Download failed. Check your connection and try again.',
        };
        statusText.textContent = next.message || descriptions[next.state];
    }

    async function refresh(): Promise<void> {
        const currentRevision = ++revision;
        if (!api) {
            render({ state: 'unsupported' });
            return;
        }
        render({ state: 'checking' });
        try {
            const state = await api.availability({ sourceLanguage: 'ja', targetLanguage: target.value });
            if (!disposed && currentRevision === revision) render({ state });
        } catch {
            if (!disposed && currentRevision === revision) render({ state: 'error', message: 'Could not check availability. Try again.' });
        }
    }

    function cancelSetup(): void {
        ++revision;
        setupController?.abort();
        setupController = null;
        progress.hidden = true;
        cancel.hidden = true;
    }

    async function save(key: StorageKey.TranslationEnabled | StorageKey.TranslationTargetLanguage): Promise<void> {
        if (key === StorageKey.TranslationEnabled) enabledPreference = enabled.checked;
        cancelSetup();
        const currentRevision = revision;
        try {
            // Write only the edited preference so another device's change is preserved.
            // The background storage listener owns resetting the translation session.
            await storage.sync.set({ [key]: key === StorageKey.TranslationEnabled ? enabled.checked : normalizeTranslationTarget(target.value) });
            if (!disposed && currentRevision === revision) await refresh();
        } catch {
            if (!disposed && currentRevision === revision) render({ state: 'error', message: 'Could not save this setting. Please try again.' });
        }
    }

    enabled.addEventListener('change', () => { void save(StorageKey.TranslationEnabled); });
    target.addEventListener('change', () => { void save(StorageKey.TranslationTargetLanguage); });
    cancel.addEventListener('click', () => {
        cancelSetup();
        void refresh();
    });
    setup.addEventListener('click', () => {
        if (!api || setupController || !settingsLoaded || !['downloadable', 'downloading', 'error'].includes(status.state)) return;
        const currentRevision = ++revision;
        const targetLanguage = target.value;
        const controller = new AbortController();
        setupController = controller;
        progress.removeAttribute('value');
        render({ state: 'downloading', message: 'Downloading… Keep this popup open.' });
        try {
            // Do not await storage, messaging or availability before create(): user activation is required.
            const creation = api.create({
                sourceLanguage: 'ja', targetLanguage, signal: controller.signal,
                monitor(monitor) {
                    monitor.addEventListener('downloadprogress', (event) => {
                        if (disposed || currentRevision !== revision || setupController !== controller) return;
                        if (!Number.isFinite(event.loaded)) return;
                        progress.value = Math.max(0, Math.min(1, event.loaded));
                        statusText.textContent = `Downloading… ${Math.round(progress.value * 100)}% · Keep this popup open.`;
                    });
                },
            });
            void creation.then(async (session) => {
                session.destroy();
                if (disposed || currentRevision !== revision) return;
                statusText.textContent = 'Finishing setup… Keep this popup open.';
                const verified = await runtime.sendMessage({
                    action: NamidaMessageAction.GetTranslationStatus,
                    data: { targetLanguage, ensureHost: true },
                }) as TranslationStatus;
                if (disposed || currentRevision !== revision) return;
                // Download/setup is complete now. Hide cancellation before committing
                // the enable preference, since a storage write cannot be aborted.
                setupController = null;
                if (verified.state === 'available' && enabledPreference !== true) {
                    // Match our own sync event locally, while still letting a newer
                    // disable/target change invalidate this setup before completion.
                    enabled.checked = true;
                    enabledPreference = true;
                    render(verified);
                    try {
                        await storage.sync.set({ [StorageKey.TranslationEnabled]: true });
                    } catch {
                        if (!disposed && currentRevision === revision) {
                            enabled.checked = false;
                            enabledPreference = false;
                            setupController = null;
                            render({ state: 'available', message: 'Downloaded. Turn on Translate Japanese to enable it.' });
                        }
                        return;
                    }
                }
                if (disposed || currentRevision !== revision) return;
                setupController = null;
                render(verified);
            }).catch(() => {
                if (!disposed && currentRevision === revision) {
                    setupController = null;
                    render({ state: 'error' });
                }
            });
        } catch {
            setupController = null;
            if (!disposed && currentRevision === revision) render({ state: 'error' });
        }
    });

    const onStorageChanged: Parameters<typeof storage.onChanged.addListener>[0] = (changes, area) => {
        if (area !== 'sync' || disposed) return;
        const enabledChange = changes[StorageKey.TranslationEnabled];
        const targetChange = changes[StorageKey.TranslationTargetLanguage];
        if (!settingsLoaded) {
            if (enabledChange) initialChanges.enabled = typeof enabledChange.newValue === 'boolean' ? enabledChange.newValue : undefined;
            if (targetChange) initialChanges.targetLanguage = normalizeTranslationTarget(targetChange.newValue);
            return;
        }
        const nextEnabled = enabledChange
            ? typeof enabledChange.newValue === 'boolean' ? enabledChange.newValue : undefined
            : enabledPreference;
        const nextTarget = targetChange ? normalizeTranslationTarget(targetChange.newValue) : target.value;
        if (enabledPreference === nextEnabled && target.value === nextTarget
            && !(setupController && enabledChange && !nextEnabled)) return;
        cancelSetup();
        enabledPreference = nextEnabled;
        target.value = nextTarget;
        void refresh();
    };
    storage.onChanged.addListener(onStorageChanged);
    window.addEventListener('pagehide', () => {
        disposed = true;
        cancelSetup();
        storage.onChanged.removeListener(onStorageChanged);
    }, { once: true });

    render(api ? { state: 'checking' } : { state: 'unsupported' });
    void Settings.getTranslationSettings().then((settings) => {
        if (disposed) return;
        enabledPreference = 'enabled' in initialChanges ? initialChanges.enabled : settings.enabled;
        target.value = initialChanges.targetLanguage ?? settings.targetLanguage;
        settingsLoaded = true;
        void refresh();
    }).catch(() => {
        if (!disposed) render(api ? { state: 'error', message: 'Could not load settings. Close and reopen this popup.' } : { state: 'unsupported' });
    });
}
