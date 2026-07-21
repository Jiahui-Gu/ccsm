/* global __dirname, module, require */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { typescriptRule } = require('./webpack.config.js');

function listSourceFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

const mobileSourceDirectory = path.resolve(__dirname, 'src/mobile');
const mobileCacheVersion = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.resolve(__dirname, 'src/phone.html')))
  .update(listSourceFiles(mobileSourceDirectory).map((file) => fs.readFileSync(file)).join(''))
  .digest('hex')
  .slice(0, 12);

module.exports = {
  entry: {
    phone: './src/mobile/index.ts',
    sw: './src/mobile/sw.ts',
  },
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist/mobile'),
    filename: '[name].[contenthash].js',
    publicPath: '',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      typescriptRule,
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __MOBILE_CACHE_VERSION__: JSON.stringify(mobileCacheVersion),
    }),
    new HtmlWebpackPlugin({
      template: './src/phone.html',
      chunks: ['phone'],
      templateParameters: (compilation) => ({
        swAsset: compilation
          .getAssets()
          .map((asset) => asset.name)
          .find((name) => /^sw\..+\.js$/.test(name)),
      }),
    }),
    new CopyPlugin({ patterns: [{ from: 'src/mobile/manifest.webmanifest' }] }),
    new MiniCssExtractPlugin({ filename: '[name].[contenthash].css' }),
  ],
  performance: {
    hints: 'warning',
    maxAssetSize: 1_638_400,
    maxEntrypointSize: 1_638_400,
  },
};
