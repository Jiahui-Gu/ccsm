const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

// `publicPath` differs between dev (served by webpack-dev-server at root)
// and production (loaded by Electron via `file://` from dist/renderer/).
// Absolute `/` works for the dev server but resolves to the drive root under
// `file://`, so production must use a relative path.
//
// Phase 2 crash observability (spec §6, plan Task 7): bake per-surface Sentry
// DSNs into the renderer bundle at build time via DefinePlugin. The packaging
// CI sets `CCSM_SENTRY_DSN_RENDERER` / `CCSM_SENTRY_DSN_MAIN` from the
// `release` environment secret; PR / fork builds run with the env unset →
// values become the literal `undefined` in built code → init short-circuits
// (electron/sentry/init.ts + src/index.tsx). Zero risk of a fork shipping the
// maintainer DSN. JSON.stringify on undefined produces literal `undefined`,
// not the string `"undefined"`, so consumer falsy-checks behave correctly.
module.exports = (_env, argv = {}) => ({
  entry: './src/index.tsx',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: 'bundle.js',
    publicPath: argv.mode === 'production' ? '' : '/'
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: { loader: 'ts-loader', options: { transpileOnly: true } }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader', 'postcss-loader']
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({ template: './src/index.html' }),
    new webpack.DefinePlugin({
      'process.env.SENTRY_DSN_RENDERER': JSON.stringify(process.env.CCSM_SENTRY_DSN_RENDERER),
      'process.env.SENTRY_DSN_MAIN': JSON.stringify(process.env.CCSM_SENTRY_DSN_MAIN),
    })
  ],
  devServer: {
    port: Number(process.env.CCSM_DEV_PORT) || 4100,
    hot: true,
    historyApiFallback: true
  }
});
