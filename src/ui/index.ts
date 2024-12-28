import { storage } from "webextension-polyfill";
import { StorageKey, UpscalingModeString } from "../interfaces/Storage";

document.addEventListener('DOMContentLoaded', () => {
    const upscalingSelect = document.getElementById("upscaling-mode") as HTMLSelectElement;
    const pageSegSelect = document.getElementById("page-seg-mode") as HTMLSelectElement;
    const saveOcrCropCheckbox = document.getElementById("save-ocr-crop") as HTMLInputElement;

    loadSettings(upscalingSelect, pageSegSelect, saveOcrCropCheckbox);

    // 2) Attach listeners to save new values
    upscalingSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.UpscalingMode] = upscalingSelect.value;
        storage.sync.set(record);
    });

    pageSegSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.PageSegMode] = pageSegSelect.value;
        storage.sync.set(record);
    });

    saveOcrCropCheckbox.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.SaveOcrCrop] = saveOcrCropCheckbox.checked;
        storage.sync.set(record);
    });


    const collapsibleButtons = document.querySelectorAll('.collapsible');

    collapsibleButtons.forEach((button) => {
        button.addEventListener('click', () => {
            // Toggle active class on the button
            button.classList.toggle('active');

            // Expand or collapse the content div
            const content = button.nextElementSibling as HTMLElement;
            if (!content) return;

            if (content.style.maxHeight) {
                content.style.maxHeight = '';
            } else {
                content.style.maxHeight = content.scrollHeight + 'px';
            }
        });
    });
});

async function loadSettings(upscalingSelect: HTMLSelectElement, pageSegSelect: HTMLSelectElement, saveOcrCropCheckbox: HTMLInputElement) {
    const values = await storage.sync.get(null);
    debugger;
    // If a value was saved before, use it. Otherwise use default.
    upscalingSelect.value = (values[StorageKey.UpscalingMode] as string | undefined) || UpscalingModeString.Canvas;
    pageSegSelect.value = (values[StorageKey.PageSegMode] as string | undefined) || "single-block-vertical";
    saveOcrCropCheckbox.checked = (values[StorageKey.SaveOcrCrop] as boolean | undefined) ?? false;
}
