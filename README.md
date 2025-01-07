# Namida OCR

**Namida OCR** is a completely local OCR browser extension for both **Chrome**, **Firefox**, and **Edge**. It enables you to take a “snip” (screenshot) of any part of your current tab, upscale it (either via basic linear upscaling or ESRGAN), and then perform OCR on the snipped region using Tesseract.js. The OCR supports Japanese vertical text at the moment and automatically copies the recognized text to your clipboard, making it easy to use with online dictionaries like [Yomitan](https://github.com/yomidevs/yomitan) or manual translation tools. Additionally, Namida OCR includes the option to speak the recognized text aloud using your browser’s text-to-speech capabilities.


***
<p align="center">
<a href="https://chromewebstore.google.com/detail/namida-ocr/fdcjeigdfljhiinbagbmlhekkbgcdnfc"><img style="height: 100px" src="https://github.com/user-attachments/assets/fc961f30-87a3-4962-856b-5dcfc6df189f" alt="Get Namida ORC for Chrome"></a>
<a href="https://addons.mozilla.org/firefox/addon/namida-ocr/"><img style="height: 100px" src="https://github.com/user-attachments/assets/e1c41eb3-5563-431b-9461-c8a839df92b4" alt="Get Namida ORC for Firefox"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/namida-ocr/idbijkhnllhjdnjmkkfjeicnalemfhnk"><img style="height: 100px" src="https://github.com/user-attachments/assets/4ee20820-86e1-432c-9cd4-47784ffa2cea" alt="Get Namida ORC for Microsoft Edge"></a>
</p>

***

## Features

- **Local OCR**  
  All OCR processing is done locally in your browser using [Tesseract.js](https://github.com/naptha/tesseract.js). No external servers are involved.

- **Snip & Upscale**  
  By default, **Alt + Q** on windows and **Option + Q** on mac activates the snipping mode. The selected image region is then upscaled:
  - **Linear Upscaling** (fast, basic)  
  - **ESRGAN** (higher-quality AI-based upscaling)

- **Japanese Vertical Text Support**  
  Namida OCR includes trained data for Japanese vertical text recognition, making it ideal for reading manga, visual novels, or other sources with vertical text layout.

- **Clipboard Copy**  
  Upon successful OCR, the recognized text is automatically copied to your clipboard so you can quickly paste it into a dictionary or translation tool.

- **Text-to-Speech (TTS)**  
  Namida OCR includes the option to speak the recognized text aloud using your browser’s TTS engine.  
  - **Chrome**: High-quality remote Japanese voices are included by default.  
  - **Firefox & Edge (Windows)**: Requires a Japanese language pack with TTS installed.  
  - **Edge**: Can also use high-quality **“natural”** voices if available via the Windows language pack.

- **Privacy-Friendly**  
  No internet connection is required during OCR, upscaling, or text-to-speech. Everything is handled using local models bundled with the extension.

## Usage

1. **Activate Snip Mode**  
   Press **Alt + Q** on windows or **Option + Q** on mac on any web page. A snipping overlay will appear.

2. **Select the Region**  
   Click and drag to highlight the area you want to OCR.

3. **Upscale & OCR**  
   - Namida OCR upscales the snipped region using your chosen method (linear or ESRGAN).  
   - Tesseract.js then performs OCR on the upscaled image.

4. **Copy to Clipboard**  
   The recognized text is automatically copied to your clipboard. You can then paste it into any dictionary, translation app, or text editor.

5. **Speak the Text** *(Optional)*  
   If enabled in settings, you can speak the recognized text aloud using your browser’s TTS capabilities. Simply click the "Speak" button in the recognition window.

## Settings

- **Upscaling Mode**  
  - **Linear** – Uses basic canvas scaling (faster but lower quality).  
  - **ESRGAN** – AI-based upscaling for sharper text.

- **Supported Languages**  
  - Japanese (jpn_vert)

- **Enable TTS**  
  - Option to enable or disable the "Speak" button for recognized text.  

- **Preferred TTS Voice**  
  - Choose which TTS voice to use when speaking recognized text. The available options depend on your browser and system configuration:
    - **Chrome**: Includes high-quality remote Japanese voices.  
    - **Firefox & Edge**: Requires a Japanese language pack with TTS support installed.  
    - **Edge (Windows)**: Can use advanced **"natural"** voices from the Windows language pack.

## Notes

- For the best experience with TTS on Firefox or Edge, ensure your system has a Japanese language pack with text-to-speech capabilities installed. On Edge, you can access **natural** voices through the Windows settings.
- Namida OCR is ideal for users looking to OCR Japanese text, including vertical text layouts commonly found in manga, visual novels, or other Japanese media.
- All processing is performed locally within the browser, ensuring privacy and offline functionality.
