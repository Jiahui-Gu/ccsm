/* global __dirname, module, require */

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { typescriptRule } = require('./webpack.config.js');

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
