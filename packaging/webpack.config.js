import { resolve } from 'node:path';
import webpack from 'webpack';
export default {
  mode: 'production', target: 'node24', devtool: false,
  entry: { cli: './packaging/entries/cli.js', daemon: './packaging/entries/daemon.js' },
  output: { path: resolve('.cache/release-build/bundle'), filename: '[name].cjs' },
  // Playwright's dynamically loaded resources are carried inside the embedded
  // archive. This external is resolved there, never from a user installation.
  externals: { playwright: 'commonjs playwright' },
  plugins: [new webpack.DefinePlugin({ __TAOBAO_PACKAGED__: true })],
  optimization: { minimize: false, splitChunks: false, runtimeChunk: false },
};
