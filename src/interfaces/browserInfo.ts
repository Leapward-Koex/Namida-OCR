export enum BrowserType {
    Chrome,
    Firefox,
    Edge
}

export const getCurrentBrowser = () => {
    if (/Firefox/.test(navigator.userAgent)) {
        return BrowserType.Firefox;
    }
    else if (/Edge/.test(navigator.userAgent)) {
        return BrowserType.Edge;
    }
    else {
        return BrowserType.Chrome;
    }
}

export const isWindows = () => {
    const windowsPlatforms = /(win32|win64|windows|wince)/i;
    return windowsPlatforms.test(globalThis.navigator.userAgent.toLowerCase());
}