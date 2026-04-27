const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// `publicPath` differs between dev (served by webpack-dev-server at root)
// and production (loaded by Electron via `file://` from dist/renderer/).
// Absolute `/` works for the dev server but resolves to the drive root under
// `file://`, so production must use a relative path.
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
  plugins: [new HtmlWebpackPlugin({ template: './src/index.html' })],
  devServer: {
    port: Number(process.env.CCSM_DEV_PORT) || 4100,
    hot: true,
    historyApiFallback: true
  }
});
