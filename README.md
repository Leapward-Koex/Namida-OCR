# Namida

**Namida** is a completely local OCR browser extension for both **Chrome** and **Firefox**. It enables you to take a “snip” (screenshot) of any part of your current tab, upscale it (either via basic linear upscaling or ESRGAN), and then perform OCR on the snipped region using Tesseract.js. The OCR supports Japanese vertical text at the moment and automatically copies the recognized text to your clipboard, making it easy to use with online dictionaries like [Yomitan](https://github.com/yomidevs/yomitan) or manual translation tools.

## Features

- **Local OCR**  
  All OCR processing is done locally in your browser using [Tesseract.js](https://github.com/naptha/tesseract.js). No external servers are involved.

- **Snip & Upscale**  
  Press **Alt + Q** to activate the snipping mode. The selected image region is then upscaled:
  - **Linear Upscaling** (fast, basic)  
  - **ESRGAN** (higher-quality AI-based upscaling)

- **Japanese Vertical Text Support**  
  Namida includes trained data for Japanese vertical text recognition, making it ideal for reading manga, visual novels, or other sources with vertical text layout.

- **Clipboard Copy**  
  Upon successful OCR, the recognized text is automatically copied to your clipboard so you can quickly paste it into a dictionary or translation tool.

- **Privacy-Friendly**  
  No internet connection is required during OCR or upscaling. Everything is handled using local models bundled with the extension.

## Usage

1. **Activate Snip Mode**  
   Press **Alt + Q** on any web page. A snipping overlay will appear.  

2. **Select the Region**  
   Click and drag to highlight the area you want to OCR.  

3. **Upscale & OCR**  
   - Namida upscales the snipped region using your chosen method (linear or ESRGAN).  
   - Tesseract.js then performs OCR on the upscaled image.  

4. **Copy to Clipboard**  
   The recognized text is automatically copied to your clipboard. You can then paste it into any dictionary, translation app, or text editor.

## Settings

- **Upscaling Mode**  
  - **Linear** – Uses basic canvas scaling (faster but lower quality).  
  - **ESRGAN** – AI-based upscaling for sharper text.  

- **Supported Languages**  
  - Japanese (jpn_vert)  
