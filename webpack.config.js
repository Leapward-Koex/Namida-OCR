const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    mode: 'development',
    entry: {
        background: './src/background/index.ts',
        content: './src/content/index.ts',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name]/index.js',
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
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
                { from: 'src/manifest.json', to: 'manifest.json' },
                // https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md#local-installation
                { from: 'node_modules/tesseract.js-core/tesseract-core.wasm.js', to: 'libs/tesseract-core/tesseract-core.wasm.js' },
                { from: 'node_modules/tesseract.js-core/tesseract-core-simd.wasm.js', to: 'libs/tesseract-core/tesseract-core-simd.wasm.js' },
                { from: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', to: 'libs/tesseract-core/tesseract-core-lstm.wasm.js' },
                { from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', to: 'libs/tesseract-core/tesseract-core-simd-lstm.wasm.js' },
                { from: 'node_modules/tesseract.js/dist/worker.min.js', to: 'libs/tesseract-worker/worker.min.js' },
                { from: 'lang/', to: 'libs/tesseract-lang/' },
                { from: 'node_modules/@upscalerjs/default-model/models/', to: 'libs/tensorflow/' },

            ],
        }),
    ],
    devtool: 'source-map',
};
