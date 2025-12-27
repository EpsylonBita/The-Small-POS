const path = require('path');
const webpack = require('webpack');

module.exports = (env, argv) => {
  const mode = argv.mode || 'production';
  const isProduction = mode === 'production';

  // Load appropriate .env file based on mode
  // Production builds should NOT include org-specific data
  const envFile = isProduction ? '.env.production' : '.env';
  require('dotenv').config({ path: envFile });
  console.log(`[Webpack] Loading environment from: ${envFile}`);

  return {
    mode: mode,
    entry: {
      main: './src/main/main.ts',
      preload: './src/preload/index.ts'  // Updated to use new secure preload
    },
    target: 'electron-main',
    output: {
      path: path.resolve(__dirname, 'dist/main'),
      filename: '[name].js'
    },
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@main': path.resolve(__dirname, 'src/main'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.main.json'
            }
          },
          exclude: /node_modules/
        }
      ]
    },
    plugins: [
      new webpack.DefinePlugin({
        'global': 'globalThis',
        'process.env.NODE_ENV': JSON.stringify(mode),
        'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
        // NOTE: SUPABASE_SERVICE_ROLE_KEY intentionally NOT bundled - bypasses RLS, security risk
        'process.env.VITE_SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
        'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
        'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
        'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
        'process.env.ADMIN_DASHBOARD_URL': JSON.stringify(process.env.ADMIN_DASHBOARD_URL),
        'process.env.TERMINAL_ID': JSON.stringify(process.env.TERMINAL_ID),
      })
    ],
    node: {
      __dirname: false,
      __filename: false
    },
    externals: {
      'better-sqlite3': 'commonjs better-sqlite3',
      'bufferutil': 'commonjs bufferutil',
      'utf-8-validate': 'commonjs utf-8-validate',
      // Native printer modules - optional dependencies
      'bluetooth-serial-port': 'commonjs bluetooth-serial-port',
      'usb': 'commonjs usb',
      'serialport': 'commonjs serialport'
    },
    optimization: {
      minimize: isProduction, // Minimize in production
      usedExports: true,      // Mark unused exports for tree-shaking
      sideEffects: true,      // Read sideEffects from package.json
      providedExports: true   // Better export tracking
    },
    performance: {
      // Disable performance hints for Electron main process
      // These warnings are meant for web bundles served over network
      // Electron main runs locally in Node.js, so bundle size is not a concern
      hints: false
    },
    stats: {
      all: false,           // Disable all stats by default
      assets: true,         // Show assets
      errors: true,         // Show errors
      warnings: true,       // Show warnings
      timings: true,        // Show timing info
      builtAt: false,       // Hide build timestamp
      colors: true          // Enable colors
    },
    ignoreWarnings: [
      /Critical dependency: the request of a dependency is an expression/,
      /Module not found: Error: Can't resolve 'bufferutil'/,
      /Module not found: Error: Can't resolve 'utf-8-validate'/,
      /Module not found: Error: Can't resolve 'bluetooth-serial-port'/,
      /Module not found: Error: Can't resolve 'usb'/,
      /Module not found: Error: Can't resolve 'serialport'/,
      // Ignore warnings from node-pre-gyp and node-gyp
      /Module not found: Error: Can't resolve 'npm'/,
      /Module not found: Error: Can't resolve 'mock-aws-s3'/,
      /Module not found: Error: Can't resolve 'aws-sdk'/,
      /Module not found: Error: Can't resolve 'nock'/,
      /Module parse failed:.*Find-VisualStudio\.cs/,
      /Unexpected token.*nw-pre-gyp.*index\.html/
    ]
  };
};