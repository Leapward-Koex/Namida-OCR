import { commands, runtime, tabs } from "webextension-polyfill";
import { NamidaMessage } from "../interfaces/message";

console.log('Background script loaded');
commands.onCommand.addListener(async (command) => {
    if (command === "toggle-feature") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { action: "toggleFeature" });
        }
    }
});

runtime.onMessage.addListener(async (message, sender) => {
    // Listen for a request to capture the visible tab
    if ((message as NamidaMessage).action === 'captureFullScreen') {
        // Use tabs.captureVisibleTab to get a screenshot of the current tab
        // NOTE: Passing {format: 'png'} ensures we get a PNG
        const base64Image = await tabs.captureVisibleTab(undefined, { format: 'png' });
        // Return the base64 image back to the content script
        return base64Image;
    }
});