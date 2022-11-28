var storybookCheck = require('./check');
var path = require('path');
var fs = require('fs');
var os = require('os');
var getPort = require('get-port');
var spawn = require('child_process').spawn;
var request = require('request');
var requestRetry = require('requestretry');
var puppeteer = require('puppeteer');
var colors = require('colors/safe');
var template = require('lodash/template');
var semver = require('semver');
var Promise = require('bluebird');
var express = require('express');
var { Server } = require('http');

var storybookObj;
/*
 * valid ports that are supported by sauce connect, please refer here:
 * https://wiki.saucelabs.com/display/DOCS/Sauce+Connect+Proxy+FAQS#SauceConnectProxyFAQs-CanIAccessApplicationsonlocalhost?
 * notice that we kicked out 5555 and 8080 for safe
*/
const VALIDPORTS = [
  2000, 2001, 2020, 2109, 2222, 2310, 3000,
  3001, 3010, 3030, 3210, 3333, 4000, 4001,
  4201, 4040, 4321, 4502, 4503, 4567, 5000,
  5001, 5002, 5050, 5432, 6000, 6001, 6060,
  6666, 6543, 7000, 7070, 7774, 7777, 8000,
  8001, 8003, 8031, 8081, 8443, 8765, 8777,
  8888, 9000, 9001, 9031, 9080, 9081, 9090,
  9191, 9876, 9877, 9999, 49221, 55001
];

var getStorybook = function(page, tries, options) {
  var maxTries = 5;
  if (options && options.debug) {
    console.log('DEBUG: getStorybook', tries);
  }
  if (typeof tries === 'undefined') {
    tries = 0;
  }
  return page.evaluate('window.__screener_storybook__()')
    .then(function(result) {
      if (tries < maxTries && (!result || (typeof result === 'object' && result.length === 0))) {
        return Promise.delay(2*1000).then(function() {
          return getStorybook(page, tries + 1, options);
        });
      }
      if (typeof result === 'object' && result.length > 0) {
        var stepsScript = fs.readFileSync(__dirname + '/scripts/story-steps.js', 'utf8');
        return page.evaluate(stepsScript);
      }
      return result;
    })
    .catch(function(ex) {
      if (options && options.debug) {
        console.error('DEBUG: getStorybook', ex);
      }
      return null;
    });
};

var storybookReady = function(port, options, callback) {
  // wait for storybook server to be ready
  setTimeout(function() {
    var baseUrl = 'http://localhost:' + port;
    var retryStrategy = function(err, response) {
      var networkError = requestRetry.RetryStrategies.HTTPOrNetworkError(err, response);
      var statusCode = response && response.statusCode;
      if (options && options.debug) {
        console.log('DEBUG: GET', baseUrl, networkError, statusCode);
      }
      return networkError || statusCode === 404;
    };
    requestRetry.get(baseUrl + '/', {retryStrategy: retryStrategy, maxAttempts: 60}, function(err, response, body) {
      if (err) return callback(err);
      if (response.statusCode != 200 || !body) {
        return callback(new Error('Error loading Storybook'));
      }
      var previewRoute = '/preview.html';
      // confirm existence of preview.html, or fallback to iframe.html
      request.get(baseUrl + previewRoute, function(err, response) {
        if (err) return callback(err);
        if (response.statusCode != 200) {
          previewRoute = '/iframe.html';
        }
        if (options && options.debug) {
          console.log('DEBUG: previewRoute', previewRoute);
        }
        // get storybook obj with puppeteer
        var launchOptions = {headless: true};
        // launch without sandbox in container-based and windows server environments
        // https://docs.travis-ci.com/user/chrome#Sandboxing
        if (os.platform() === 'linux' || os.platform() === 'win32') {
          launchOptions.args = ['--no-sandbox'];
        }
        var browser, page;
        var done = function() {
          callback(null, {port: port, preview: previewRoute});
        };
        puppeteer.launch(launchOptions)
          .then(function(_browser) {
            browser = _browser;
            return browser.newPage();
          })
          .then(function(_page) {
            page = _page;
            if (options && options.debug) {
              console.log('DEBUG: GET', baseUrl + previewRoute);
            }
            return page.goto(baseUrl + previewRoute, {timeout: 300000});
          })
          .then(function() {
            return getStorybook(page, 0, options);
          })
          .then(function(result) {
            storybookObj = result;
            return browser.close();
          })
          .then(done)
          .catch(function(ex) {
            if (options && options.debug) {
              console.error(ex);
            }
            if (browser) {
              return browser.close().then(done);
            }
            done();
          });
      });
    });
  }, 3*1000);
};

var staticServer = exports.staticServer = function(config, options, callback) {
  // confirm static folder exists
  var storybookBuildPath = path.resolve(process.cwd(), config.storybookStaticBuildDir);
  if (!fs.existsSync(storybookBuildPath)) {
    return callback(new Error('Error: \'storybookStaticBuildDir\' directory not found.'));
  }
  console.log('Use Static Storybook Build:\n' + storybookBuildPath);
  // find free port
  getPort({ port: VALIDPORTS }).then(function(port) {
    var expressApp = express();
    var fileServer = Server(expressApp);
    expressApp.use(express.static(storybookBuildPath, {maxAge: 900}));
    fileServer.listen(port, '127.0.0.1', function(err) {
      if (err) {
        return callback(new Error('Error starting static server to ' + storybookBuildPath + ': ' + err.toString()));
      }
      console.log('Started server: http://localhost:' + port);
      storybookReady(port, options, callback);
    });
  }).catch(callback);
};

var setLegacyConfig = exports.setStorybookConfig = function(storybookApp, storybookVersion, storybookConfigDir) {
  console.warn('DEBUG storybookApp', storybookApp);
  console.warn('DEBUG storybookVersion', storybookVersion);
  console.warn('DEBUG storybookConfigDir', storybookConfigDir);
  var configPath = path.resolve(process.cwd(), storybookConfigDir, 'config.js');
  var isNewFile = false;
  if (!fs.existsSync(configPath)) {
    // handle declarative configuration and preview.js in Storybook 5.3+
    // more info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#from-version-52x-to-53x
    if (storybookVersion.major >= 5 && semver.gt(storybookVersion.full, '5.2.0')) {
      configPath = path.resolve(process.cwd(), storybookConfigDir, 'preview.js');
      if (!fs.existsSync(configPath)) {
        // check for typescript file
        var tsConfigPath = path.resolve(process.cwd(), storybookConfigDir, 'preview.ts');
        if (fs.existsSync(tsConfigPath)) {
          configPath = tsConfigPath;
        } else {
          // generate file when does not exist (temporary, remove later)
          fs.writeFileSync(configPath, '', 'utf8');
          isNewFile = true;
        }
      }
    } else {
      throw new Error('Storybook config file not found: ' + configPath);
    }
  }
  // store original file contents
  var configBody = fs.readFileSync(configPath, 'utf8');
  // generate code to expose storybook; code dependent on storybook version
  var templateType = 'default';
  if (storybookVersion.major === 2) {
    templateType = 'v' + storybookVersion.major;
  }
  var templatePath = path.resolve(__dirname, 'templates', templateType + '.template');
  var codeTemplate = fs.readFileSync(templatePath, 'utf8');
  var code = template(codeTemplate)({ code: configBody, app: storybookApp });
  // inject temp code into storybook config file to expose storybook
  fs.writeFileSync(configPath, code, 'utf8');
  return {
    path: configPath,
    body: configBody,
    isNewFile: isNewFile
  };
};

var resetLegacyConfig = exports.resetStorybookConfig = function({path: configPath, body, isNewFile}, allowRemoveFile) {
  console.info('resetStorybookConfig sees configPath', configPath);

  if (fs.existsSync(configPath)) {
    if (isNewFile && allowRemoveFile) {
      // clean-up generated file
      fs.unlinkSync(configPath);
    } else if (fs.readFileSync(configPath, 'utf8') !== body) {
      // revert file back to original contents
      fs.writeFileSync(configPath, body, 'utf8');
    }
  }
};

const restorePreviewSource = exports.resetPreviewSource = function(storybookConfig, fileBody) {
  console.info('restoring previous verson of preview source file', storybookConfig.previewSource);

  const previewSource = storybookConfig.previewSource;
  if (fs.existsSync(previewSource)) {
    if (fileBody) {
      // revert file back to original contents
      fs.writeFileSync(previewSource, fileBody, 'utf8');
    } else {
      // we didn't read anything there before
      fs.unlinkSync(previewSource);
    }
  }
};

var configureFeatureServer = exports.configureFeatureServer = function(storybookConfig) {
  console.warn('DEBUG configureFeatureServer storybookConfig', storybookConfig);

  const previewSource = storybookConfig.previewSource;
  let previewBody;

  // hold original file contents
  if (fs.existsSync(previewSource)) {
    previewBody = fs.readFileSync(previewSource, 'utf8');
  } else {
    // generate file when does not exist (temporary, remove later)
    fs.writeFileSync(previewSource, '', 'utf8');
  }

  // add store global hook (for now)
  var templateType = 'storeV7';
  var templatePath = path.resolve(__dirname, 'templates', templateType + '.template');
  var codeTemplate = fs.readFileSync(templatePath, 'utf8');
  var code = template(codeTemplate)({ code: previewBody });
  fs.writeFileSync(previewSource, code, 'utf8');
  return previewBody;
};

const isWindowsPlatform = function() {
  return /^win/.test(process.platform);
};

//  Pre SB6.4 approach of user defined config dir, package interrogation
//
const launchLegacyServer = function(config, options, port, callback) {
  var storybookApp;
  var storybookVersion;
  if (!config || !config.storybookConfigDir) {
    return callback(new Error('Error: \'storybookConfigDir\' not found in config file.'));
  }
  if ([2, 3, 4, 5].indexOf(config.storybookVersion) > -1) {
    storybookApp = 'react';
    if (['react', 'vue', 'angular', 'html'].indexOf(config.storybookApp) > -1) {
      storybookApp = config.storybookApp;
    }
    storybookVersion = {
      major: config.storybookVersion,
      full: config.storybookVersion + '.0.0'
    };
  } else {
    // check storybook module
    try {
      var pkg = storybookCheck();
      storybookApp = pkg.app;
      storybookVersion = pkg.version;
    } catch(ex) {
      return callback(ex);
    }
  }

  // find free port
  getPort({ port: VALIDPORTS }).then(function(port) {
    var configObj;
    try {
      configObj = setLegacyConfig(storybookApp, storybookVersion, config.storybookConfigDir);
    } catch(ex) {
      return callback(ex);
    }
    // start Storybook dev server
    var binPath = path.resolve(process.cwd(), 'node_modules/.bin');
    if (config.storybookBinPath) {
      binPath = config.storybookBinPath;
      console.log('Use custom storybook bin path: ' + binPath);
    }
    var bin = path.resolve(binPath, 'start-storybook');
    var isWin = isWindowsPlatform();
    if (isWin) {
      bin += '.cmd';
    }
    var args = ['--port', port, '--config-dir', config.storybookConfigDir];
    // TODO: this looks like dead code or undocumented legacy?  see conflicting `storybookStaticBuildDir`
    if (config.storybookStaticDir) {
      args.push('--static-dir');
      args.push(config.storybookStaticDir);
    }
    // support storybook v4+ `--ci` flag starting from v4.0.0-alpha.23
    if (storybookVersion.major >= 4 && semver.gt(storybookVersion.full, '4.0.0-alpha.22')) {
      args.push('--ci');
    }
    console.log('\nStarting Storybook server...');
    console.log('>', 'start-storybook', args.join(' '), '\n\nPlease wait. Starting Storybook may take a minute...\n');
    var serverProcess = spawn(bin, args, {detached: !isWin});
    if (options && (options.debug || options.serverOnly)) {
      serverProcess.stdout.on('data', function(data) { console.log(data.toString('utf8').trim()); });
      serverProcess.stderr.on('data', function(data) { console.error(data.toString('utf8').trim()); });
    }

    // clean-up all child processes when this process is terminated
    process.on('exit', function() {
      resetLegacyConfig(configObj, true);
      if (!isWin) {
        process.kill(-serverProcess.pid);
      }
    });
    process.on('SIGINT', function() {
      process.exit();
    });
    process.on('uncaughtException', function(err) {
      console.error(err);
      process.exit(1);
    });

    storybookReady(port, options, function(err, result) {
      try {
        // reset config file to original code
        resetLegacyConfig(configObj);
      } catch(ex) {
        return callback(ex);
      }
      callback(null, result);
    });
  }).catch(callback);
};

const launchFeatureServer = function(screenerConfig, options, port, storybookConfig, callback) {
  const isWin = isWindowsPlatform();

  let previewBody;
  try {
    previewBody = configureFeatureServer(storybookConfig);
    console.info('configureFeatureServer found prior preview source file with:', previewBody);
  } catch(ex) {
    return callback(ex);
  }

  // start Storybook dev server
  const binPath = path.resolve(process.cwd(), 'node_modules/.bin');
  let bin = path.resolve(binPath, 'start-storybook');
  if (isWin) {
    bin += '.cmd';
  }
  console.info('screener-storybook using SB server startup bin', bin);

  const args = ['--port', port, '--config-dir', storybookConfig.dotStorybookPath];

  console.info('\nStarting Storybook server...');
  console.info('>', 'start-storybook', args.join(' '), '\n\nPlease wait. Starting Storybook may take a minute...\n');
  const serverProcess = spawn(bin, args, {detached: !isWin});
  if (options && (options.debug || options.serverOnly)) {
    serverProcess.stdout.on('data', function(data) { console.log(data.toString('utf8').trim()); });
    serverProcess.stderr.on('data', function(data) { console.error(data.toString('utf8').trim()); });
  }

  // clean-up all child processes when this process is terminated
  process.on('exit', function() {
    restorePreviewSource(storybookConfig, previewBody);
    if (!isWin) {
      process.kill(-serverProcess.pid);
    }
  });
  process.on('SIGINT', function() {
    process.exit();
  });
  process.on('uncaughtException', function(err) {
    console.error(err);
    process.exit(1);
  });

  storybookReady(port, options, function(err, result) {
    try {
      restorePreviewSource(storybookConfig, previewBody);
    } catch(ex) {
      return callback(ex);
    }
    callback(null, result);
  });
};

exports.server = function(screenerConfig, options, callback) {
  console.info('screener-storybook/storybook.js server sees screener config', screenerConfig);
  console.info('screener-storybook/storybook.js server sees options', options);

  // screener may be configured to use the static build
  if (screenerConfig.storybookStaticBuildDir) {
    return staticServer(screenerConfig, options, callback);
  }

  // check versions and features
  try {
    // find free port and launch the server from it's binary
    getPort({ port: VALIDPORTS }).then(function(port) {
      console.info('launching screener-storybook on port', port);

      const storybookConfig = storybookCheck();
      if (!storybookConfig.framework) {  // SB6.3-
        return launchLegacyServer(screenerConfig, options, port, callback);
      }

      //  This is our normal course since SB 6.4, whereby a main.js should indicate
      //  a framework being used by the site under test, and features (some optional)
      //  and some default are specified.

      // TODO:
      // * do we need the --ci flag?
      // * launching from binary is unnecessary if we run as an AddOn

      launchFeatureServer(screenerConfig, options, port, storybookConfig, callback);

      console.info('LAUNCH screener-storybook end of sync launch setup');
    }).catch(callback);

  } catch(ex) {
    return callback(ex);
  }
};

exports.get = function(options) {
  if (!storybookObj) {
    console.error(colors.red('Error getting Storybook object'));
    if (options && options.debug) {
      console.error(colors.red('Please send debug output to help@saucelabs.com'));
    } else {
      console.error(colors.red('Please re-run with --debug flag, and send debug output to help@saucelabs.com'));
    }
    throw new Error('Storybook object not found');
  }
  return storybookObj;
};
