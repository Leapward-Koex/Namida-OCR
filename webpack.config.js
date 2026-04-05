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

module.exports = (env) => {
    const browser = env.browser || 'firefox';
    const buildNumber = env.build_number || "1.0.0";
    const ocrModel = env.ocr_model || process.env.NAMIDA_OCR_MODEL || 'jpn_vert';

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
        },
        resolve: {
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
                __NAMIDA_OCR_MODEL__: JSON.stringify(ocrModel),
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
                    ...getBundledLanguagePatterns(),
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
