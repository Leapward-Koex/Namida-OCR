const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

function getBundledLanguagePatterns() {
    const langDirectory = path.resolve(__dirname, 'lang');
    const bundledModels = new Map();

    if (!fs.existsSync(langDirectory)) {
        return [];
    }

    for (const entry of fs.readdirSync(langDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) {
            continue;
        }

        const gzippedMatch = entry.name.match(/^(.*)\.traineddata\.gz$/);
        if (gzippedMatch && !bundledModels.has(gzippedMatch[1])) {
            bundledModels.set(gzippedMatch[1], {
                absolutePath: path.join(langDirectory, entry.name),
                alreadyGzipped: true,
            });
            continue;
        }

        const plainMatch = entry.name.match(/^(.*)\.traineddata$/);
        if (plainMatch) {
            bundledModels.set(plainMatch[1], {
                absolutePath: path.join(langDirectory, entry.name),
                alreadyGzipped: false,
            });
        }
    }

    return [...bundledModels.entries()]
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([modelName, bundle]) => ({
            from: bundle.absolutePath,
            to: `libs/tesseract-lang/${modelName}.traineddata.gz`,
            transform(content) {
                return bundle.alreadyGzipped ? content : zlib.gzipSync(content);
            },
        }));
}

function normalizeBooleanEnvFlag(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value !== 'string') {
        return false;
    }

    const normalizedValue = value.trim().toLowerCase();
    return normalizedValue === '1'
        || normalizedValue === 'true'
        || normalizedValue === 'yes'
        || normalizedValue === 'on';
}

function resolvePaddleOcrModelVariant(browser, env) {
    const requestedVariant = env.paddleonnx_model_variant
        || process.env.NAMIDA_PADDLE_ONNX_MODEL_VARIANT
        || (browser === 'firefox' ? 'mobile_det_server_rec' : 'server');

    const normalizedVariant = String(requestedVariant).trim().toLowerCase();
    const bundlePath = path.resolve(__dirname, 'models/paddleocr', normalizedVariant);
    if (!fs.existsSync(bundlePath)) {
        throw new Error(
            `Missing PaddleOCR bundle for variant "${normalizedVariant}" at ${bundlePath}. `
            + 'Generate it with prepare-paddleocr-onnx.py before building.',
        );
    }

    return normalizedVariant;
}

module.exports = (env) => {
    const browser = env.browser || 'firefox';
    const buildNumber = env.build_number || "1.0.0";
    const ocrModel = env.ocr_model || process.env.NAMIDA_OCR_MODEL || 'jpn_vert';
    const ocrBackend = env.ocr_backend || process.env.NAMIDA_OCR_BACKEND || 'tesseract';
    const paddleOcrModelVariant = resolvePaddleOcrModelVariant(browser, env);
    const disablePaddleOnnxWasmFallback = normalizeBooleanEnvFlag(
        env.paddleonnx_disable_wasm_fallback ?? process.env.NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK,
    );
    const resolvedOcrBackend = ocrBackend === 'scribejs'
        ? 'scribejs'
        : ocrBackend === 'paddleonnx'
            ? 'paddleonnx'
            : 'tesseract';
    const resolveAliases = {
        'namida-ocr-backend$': path.resolve(
            __dirname,
            resolvedOcrBackend === 'scribejs'
                ? 'src/background/ocr/ScribeOcrBackend.ts'
                : 'src/background/ocr/RuntimeSelectableOcrBackend.ts',
        ),
        'namida-background-ocr-service$': path.resolve(
            __dirname,
            browser === 'chrome'
                ? 'src/background/ocr/BackgroundOcrService.stub.ts'
                : 'src/background/ocr/BackgroundOcrService.ts',
        ),
    };

    if (resolvedOcrBackend === 'scribejs') {
        // scribe.js-ocr 0.10.1's SIMD core variants abort at recognize() with a missing
        // DotProductSSE symbol in our build/runtime. Force its worker-script imports to the
        // matching non-SIMD cores until the upstream package is usable as-is.
        Object.assign(resolveAliases, {
            '../core/tesseract-core-relaxedsimd-lstm.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core/tesseract-core-lstm.js'),
            '../core/tesseract-core-simd-lstm.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core/tesseract-core-lstm.js'),
            '../core/tesseract-core-relaxedsimd.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core/tesseract-core.js'),
            '../core/tesseract-core-simd.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core/tesseract-core.js'),
            '../core_vanilla/tesseract-core-relaxedsimd-lstm.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core_vanilla/tesseract-core-lstm.js'),
            '../core_vanilla/tesseract-core-simd-lstm.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core_vanilla/tesseract-core-lstm.js'),
            '../core_vanilla/tesseract-core-relaxedsimd.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core_vanilla/tesseract-core.js'),
            '../core_vanilla/tesseract-core-simd.js$': path.resolve(__dirname, 'node_modules/scribe.js-ocr/tess/core_vanilla/tesseract-core.js'),
        });
    }

    const createManifest = () => {
        const broswerSpecificManifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, `manifests/manifest.${browser}.json`), 'utf8')
        );

        const baseManifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, 'manifests/manifest.base.json'), 'utf8')
        );

        fs.writeFileSync(
            path.resolve(__dirname, 'dist/manifest.json'),
            JSON.stringify(merged = {
                ...baseManifest,
                ...broswerSpecificManifest,
                version: buildNumber
            }, null, 2)
        );
    };
    return {
        entry: {
            background: './src/background/index.ts',
            content: './src/content/index.ts',
            ui: './src/ui/index.ts',
            offscreen: './src/offscreen/index.ts',
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: '[name]/index.js',
            chunkFilename: '[name]/index.js',
            publicPath: '/',
            clean: true,
        },
        resolve: {
            alias: resolveAliases,
            extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
            fallback: {
                "path": require.resolve("path-browserify")
            }
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        plugins: [
            new webpack.DefinePlugin({
                process: 'undefined',
                DISABLE_DOCX_XLSX: JSON.stringify(true),
                __NAMIDA_OCR_BACKEND__: JSON.stringify(resolvedOcrBackend),
                __NAMIDA_OCR_MODEL__: JSON.stringify(ocrModel),
                __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__: JSON.stringify(disablePaddleOnnxWasmFallback),
            }),
            new CopyPlugin({
                patterns: [
                    { from: 'src/ui/popup.html', to: 'ui/popup.html' },
                    { from: 'src/offscreen/offscreen.html', to: 'offscreen/offscreen.html' },
                    { from: 'src/ui/styles.css', to: 'ui/styles.css' },
                    // https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md#local-installation
                    // { from: 'node_modules/tesseract.js-core/tesseract-core.wasm.js', to: 'libs/tesseract-core/tesseract-core.wasm.js' }, // These exceed firefox 4MB js file limit
                    // { from: 'node_modules/tesseract.js-core/tesseract-core-simd.wasm.js', to: 'libs/tesseract-core/tesseract-core-simd.wasm.js' },  // These exceed firefox 4MB js file limit
                    { from: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', to: 'libs/tesseract-core/tesseract-core-lstm.wasm.js' },
                    { from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', to: 'libs/tesseract-core/tesseract-core-simd-lstm.wasm.js' },
                    { from: 'node_modules/tesseract.js/dist/worker.min.js', to: 'libs/tesseract-worker/worker.min.js' },
                    { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', to: 'libs/onnxruntime/ort-wasm-simd-threaded.mjs' },
                    { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', to: 'libs/onnxruntime/ort-wasm-simd-threaded.wasm' },
                    { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', to: 'libs/onnxruntime/ort-wasm-simd-threaded.jsep.mjs' },
                    { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', to: 'libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm' },
                    ...getBundledLanguagePatterns(),
                    {
                        from: `models/paddleocr/${paddleOcrModelVariant}`,
                        to: 'libs/paddleocr',
                        globOptions: {
                            ignore: ['**/manifest.json'],
                        },
                    },
                    {
                        from: `models/paddleocr/${paddleOcrModelVariant}/manifest.json`,
                        to: 'libs/paddleocr/paddleocr-manifest.json',
                    },
                    { from: 'node_modules/@upscalerjs/esrgan-medium/models/x2', to: 'libs/tensorflow/x2' },
                    { from: 'node_modules/@leapward-koex/kuromoji/dict_extension_spoofed', to: 'libs/kuromoji' },
                    {
                        from: 'assets/', to: 'assets/', globOptions: {
                            ignore: [
                                '**/*.pdn',
                                '**/*.txt',
                                '**/Demo picture.png'
                            ]
                        }
                    },

                ],
            }),
            {
                apply: (compiler) => {
                    compiler.hooks.afterEmit.tap('GenerateManifestPlugin', (compilation) => {
                        compilation.fileDependencies.add(path.resolve(__dirname, 'manifests/manifest.base.json'));
                        compilation.fileDependencies.add(path.resolve(__dirname, `manifests/manifest.${browser}.json`));
                        createManifest();
                    });
                },
            },
        ],
    };
}
