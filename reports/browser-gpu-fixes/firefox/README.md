# Installed Firefox validation

`validate-firefox.mjs` controls an already launched, isolated Firefox through its official WebDriver BiDi protocol. It temporarily installs a **copy** of a Firefox extension build, opens its popup, checks three OCR requests (GPU enabled twice, then disabled), and checks the actual Firefox AI image response. No dependency or browser download is needed; use Node 24's built-in WebSocket.

The script verifies Firefox's profile path before installing anything or closing the browser. Its output, extension copy and profile must remain inside this workspace. It does not delete profiles or modify the supplied build. The only addition to the test extension is a background script that opens a popup tab; inference code, models and permissions remain unchanged.

## Run from the repository root

First prepare a Firefox build with `npm run build:firefox`, or pass an existing preserved Firefox build with `--build`. The default build path is `dist`; a Chromium build is rejected. Use a new output/profile directory for each run.

```powershell
$runDirectory = Join-Path (Get-Location).Path ('.tmp\firefox-validation-' + [guid]::NewGuid().ToString('N'))
$profileDirectory = Join-Path $runDirectory 'profile'
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$debugPort = 9337
if (Get-NetTCPConnection -LocalPort $debugPort -State Listen -ErrorAction SilentlyContinue) {
    throw 'The selected debug port is occupied; choose another port.'
}
$firefoxProcess = Start-Process -FilePath 'C:\Program Files\Mozilla Firefox\firefox.exe' `
    -ArgumentList @('--headless', '--no-remote', '--new-instance', '--profile', ('"' + $profileDirectory + '"'),
        '--remote-debugging-port', $debugPort, '--remote-allow-system-access', 'about:blank') `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runDirectory 'firefox-stdout.log') `
    -RedirectStandardError (Join-Path $runDirectory 'firefox-stderr.log')
$firefoxProcess.Id | Set-Content (Join-Path $runDirectory 'launcher-pid.txt')
& 'C:\Program Files\nodejs\node.exe' .\reports\browser-gpu-fixes\firefox\validate-firefox.mjs `
    --build dist --output $runDirectory --profile $profileDirectory --port $debugPort --launcher-pid $firefoxProcess.Id
```

Firefox's launcher PID can differ from its browser PID. The session response records the actual `moz:processID` and `moz:profile` in `firefox-validation-result.json`. The script uninstalls the temporary addon and sends `browser.close` in `finally`. If the process is interrupted or connection fails, check these recorded PIDs/profile paths and close only that isolated browser; never stop all Firefox processes. Profile directories are retained for inspection and are never automatically removed.

`--remote-allow-system-access` is an **automation flag** required by Firefox to evaluate extension pages through BiDi. It permits broad Gecko access in this isolated test browser; it is not a Namida setting or a WebGPU, driver, signing, TLS, or sandbox override. Debugging stays on loopback, and no personal browser profile is used. [Mozilla's connection guide](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection), [Remote Agent access model](https://firefox-source-docs.mozilla.org/remote/Security.html).

The install command accepts an unpacked extension path and defaults to temporary installation. [Mozilla implementation](https://github.com/mozilla-firefox/firefox/blob/main/remote/webdriver-bidi/modules/root/webExtension.sys.mjs), [BiDi install specification](https://w3c.github.io/webdriver-bidi/#command-webExtension-install).

## Historical observation

[historical-firefox155-result.json](historical-firefox155-result.json) records the successful 12 September 2026 run with Firefox **155.0.1** and Namida's `mobile_det_server_rec` bundle. All three OCR requests returned `日本語 OCR Test 2026`; AI upscaling returned a decoded **16×16 PNG from an 8×8 image**. The first GPU request found no adapter and recovered into WASM; the second reused it; disabling GPU created a fresh CPU worker. Addon removal and browser closure succeeded.

**This was a headless run with no hardware adapter available. It validates Firefox packaging, isolated workers, local WASM fallback and AI image handling; it does not prove Firefox hardware WebGPU execution or establish behavior in a normal visible window.** The historical probe used the same required automation flag and popup-opening instrumentation. The reusable script adds assertions, path checks and CLI options; it was syntax-checked after adaptation, without rerunning the historical browser session.
