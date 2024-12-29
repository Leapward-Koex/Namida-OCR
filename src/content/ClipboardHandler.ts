// src/content/ClipboardHandler.ts

export class ClipboardHandler {
    private static logTag = `[${ClipboardHandler.name}]`;
    public static async copyText(text: string | undefined): Promise<void> {
        if (text) {
            try {
                console.debug(ClipboardHandler.logTag, "Trying to copy", text, "to the users clipboard");
                await navigator.clipboard.writeText(text);
                console.debug(ClipboardHandler.logTag, "Text copied to clipboard:", text);
            } catch (error) {
                console.error(ClipboardHandler.logTag, "Failed to copy text to clipboard", error);
            }
        }
    }
}
