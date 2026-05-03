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
    // The @ccsm/electron source uses ESM-style relative imports with `.js`
    // suffixes that point at sibling `.ts` / `.tsx` source files (Node 16+
    // ESM convention; tsc's `moduleResolution: "NodeNext"` resolves them
    // because the runtime files will live at `.js` once compiled). Webpack
    // does not natively rewrite — opt-in via `extensionAlias`.
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // T6.6 boot wiring imports providers from the @ccsm/electron source
      // tree (renderer subset). The package has no `exports` map yet — its
      // `main` only points at the pre-built main-process entry — so we
      // alias the renderer/rpc subpath directly to source. ts-loader picks
      // the .tsx files up via the `extensions` list above.
      '@ccsm/electron': path.resolve(__dirname, 'packages/electron/src'),
      // @ccsm/electron source imports `@ccsm/proto` (proto descriptors +
      // generated message schemas). Root `npm ci` doesn't link workspace
      // packages, so we alias to the package's `src/index.ts` entry — the
      // package's own `exports` map already points there for pnpm
      // consumers and we mirror it for the webpack/npm path.
      '@ccsm/proto': path.resolve(__dirname, 'packages/proto/src/index.ts'),
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        // ts-loader normally excludes node_modules, but the @ccsm/proto
        // workspace package is symlinked there and its source must compile
        // (it `export *`s straight from src/). Allow @ccsm scopes through.
        exclude: /node_modules[\\/](?!@ccsm[\\/])/,
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
