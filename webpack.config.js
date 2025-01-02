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
