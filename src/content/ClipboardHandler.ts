// src/content/ClipboardHandler.ts

export class ClipboardHandler {
    public static async copyText(text: string): Promise<void> {
        try {
            console.debug("Trying to copy", text, "to the users clipboard");
            await navigator.clipboard.writeText(text);
            console.debug("Text copied to clipboard:", text);
        } catch (error) {
            console.error("Failed to copy text to clipboard", error);
        }
    }
}
