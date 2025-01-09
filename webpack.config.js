const path = require('path');
const fs = require('fs');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env) => {
    const browser = env.browser || 'firefox';
    const buildNumber = env.build_number || "1.0.0";

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

    const copyXenovaModels = () => {
        if (browser !== 'firefox') {
            fs.mkdirSync(path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/onnx/'), { recursive: true });
            fs.copyFileSync(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/config.json'), path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/config.json'));
            fs.copyFileSync(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/tokenizer.json'), path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/tokenizer.json'));
            fs.copyFileSync(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/tokenizer_config.json'), path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/tokenizer_config.json'));
            fs.copyFileSync(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/onnx/encoder_model_int8.onnx'), path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/onnx/encoder_model_int8.onnx'));
            fs.copyFileSync(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/onnx/decoder_model_merged_int8.onnx'), path.resolve(__dirname, 'dist/xenovaModels/onnx-community/opus-mt-ja-en/onnx/decoder_model_merged_int8.onnx'));
        }
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
            // Otherwise we get `Uncaught ReferenceError: document is not defined`
            chunkLoading: false,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
            alias: {
                '@huggingface/transformers': path.resolve(__dirname, 'node_modules/@huggingface/transformers') // https://github.com/huggingface/transformers.js/issues/911#issuecomment-2372655914
            }
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ]
        },
        plugins: [
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
                    { from: 'lang/jpn_vert.traineddata', to: 'libs/tesseract-lang/jpn_vert.traineddata' },
                    { from: 'node_modules/@upscalerjs/esrgan-medium/models/x2', to: 'libs/tensorflow/x2' },
                    {
                        from: 'assets/', to: 'assets/', globOptions: {
                            ignore: [
                                '**/*.pdn',
                                '**/*.txt',
                                '**/Demo picture.png',
                                '**/CWS DemoPicture.png'
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
            {
                apply: (compiler) => {
                    compiler.hooks.afterEmit.tap('CopyXenovaModels', (compilation) => {
                        compilation.fileDependencies.add(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/config.json'));
                        compilation.fileDependencies.add(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/tokenizer.json'));
                        compilation.fileDependencies.add(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/tokenizer_config.json'));
                        compilation.fileDependencies.add(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/onnx/encoder_model_int8.onnx'));
                        compilation.fileDependencies.add(path.resolve(__dirname, 'xenovaModels/onnx-community/opus-mt-ja-en/onnx/decoder_model_merged_int8.onnx'));
                        copyXenovaModels();
                    });
                },
            },
        ],
    };
}
