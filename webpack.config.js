const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// `publicPath` differs between dev (served by webpack-dev-server at root)
// and production (loaded by Electron via `file://` from dist/renderer/).
// Absolute `/` works for the dev server but resolves to the drive root under
// `file://`, so production must use a relative path.
module.exports = (_env, argv = {}) => ({
  entry: {
    bundle: './src/index.tsx',
    phone: './src/mobile/phonePage.ts',
  },
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: '[name].js',
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
    new HtmlWebpackPlugin({ template: './src/index.html', filename: 'index.html', chunks: ['bundle'] }),
    new HtmlWebpackPlugin({ template: './src/phone.html', filename: 'phone.html', chunks: ['phone'] }),
  ],
  // Surface renderer bundle bloat without breaking CI. In production we warn
  // (not error) once an asset/entrypoint exceeds 1.6 MiB; the current bundle is
  // ~1.24 MB, so today's build stays quiet but future growth gets flagged. In
  // dev mode hints are disabled to avoid noise during HMR rebuilds.
  performance:
    argv.mode === 'production'
      ? {
          hints: 'warning',
          maxAssetSize: 1638400,
          maxEntrypointSize: 1638400
        }
      : { hints: false },
  devServer: {
    port: Number(process.env.CCSM_DEV_PORT) || 4100,
    hot: true,
    historyApiFallback: true
  }
});
