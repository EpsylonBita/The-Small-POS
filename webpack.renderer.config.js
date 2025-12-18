const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = (env, argv) => {
  const mode = argv.mode || 'production';
  const isProduction = mode === 'production';
  
  // Load appropriate .env file based on mode
  // Production builds should NOT include org-specific data
  const envFile = isProduction ? '.env.production' : '.env';
  require('dotenv').config({ path: path.resolve(__dirname, envFile) });
  console.log(`[Webpack Renderer] Loading environment from: ${envFile}`);

  return {
    entry: [
      path.resolve(__dirname, 'src/renderer/polyfills.ts'),
      path.resolve(__dirname, 'src/renderer/index.tsx')
    ],
    target: 'web',
    output: {
      path: path.resolve(__dirname, 'dist/renderer'),
      filename: 'renderer.js',
      publicPath: isProduction ? './' : '/'
    },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared')
    },
    mainFields: ['es2015', 'module', 'main'],
    fallback: {
      "path": require.resolve("path-browserify"),
      "os": require.resolve("os-browserify/browser"),
      "crypto": require.resolve("crypto-browserify"),
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer"),
      "process": require.resolve("process/browser"),
      "util": require.resolve("util/"),
      "url": require.resolve("url/"),
      "http": false,
      "https": false,
      "zlib": false,
      "fs": false,
      "net": false,
      "tls": false
    }
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json'
          }
        },
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: [
          'style-loader',
          'css-loader',
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                plugins: [
                  require('tailwindcss'),
                  require('autoprefixer')
                ]
              }
            }
          }
        ]
      },
      {
        test: /\.(png|jpe?g|gif|svg)$/i,
        type: 'asset/resource'
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'public', 'index.html'),
      filename: 'index.html',
      inject: 'body'
    }),
    new webpack.DefinePlugin({
      'global': 'globalThis',
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.ELECTRON_RENDERER': JSON.stringify(true),
      'process.env.SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
      'process.env.SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
      'process.env.ADMIN_DASHBOARD_URL': JSON.stringify(process.env.ADMIN_DASHBOARD_URL),
      '__dirname': '""',
      '__filename': '""',
    }),
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
      global: 'globalThis'
    })
  ],
  optimization: {
    splitChunks: {
      chunks: 'async',  // Only split async chunks for dynamic imports
      minSize: 30000    // Minimum size for splitting
    },
    usedExports: true,
    sideEffects: true,      // Read sideEffects from package.json
    providedExports: true   // Better export tracking
  },
  performance: {
    // Disable performance hints for Electron renderer
    // The renderer loads locally from disk, not over network
    // Bundle size doesn't significantly impact load time for local files
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
    /Module not found: Error: Can't resolve 'utf-8-validate'/
  ],
  devServer: {
    port: 3002,
    hot: true,
    historyApiFallback: true,
    static: {
      directory: path.join(__dirname, 'dist/renderer')
    }
  }
  };
};