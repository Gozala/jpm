/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @see http://mxr.mozilla.org/mozilla-central/source/js/src/xpconnect/loader/mozJSComponentLoader.cpp

'use strict';

// IMPORTANT: Avoid adding any initialization tasks here, if you need to do
// something before add-on is loaded consider addon/runner module instead!

const { classes: Cc, Constructor: CC, interfaces: Ci, utils: Cu,
        results: Cr, manager: Cm } = Components;
const ioService = Cc['@mozilla.org/network/io-service;1'].
                  getService(Ci.nsIIOService);
const resourceHandler = ioService.getProtocolHandler('resource').
                        QueryInterface(Ci.nsIResProtocolHandler);
const systemPrincipal = CC('@mozilla.org/systemprincipal;1', 'nsIPrincipal')();
const scriptLoader = Cc['@mozilla.org/moz/jssubscript-loader;1'].
                     getService(Ci.mozIJSSubScriptLoader);
const prefService = Cc['@mozilla.org/preferences-service;1'].
                    getService(Ci.nsIPrefService).
                    QueryInterface(Ci.nsIPrefBranch);
const appInfo = Cc["@mozilla.org/xre/app-info;1"].
                getService(Ci.nsIXULAppInfo);
const vc = Cc["@mozilla.org/xpcom/version-comparator;1"].
           getService(Ci.nsIVersionComparator);

const REASON = [ 'unknown', 'startup', 'shutdown', 'enable', 'disable',
                 'install', 'uninstall', 'upgrade', 'downgrade' ];

const bind = Function.call.bind(Function.bind);

let loader = null;
let unload = null;
let loaderSandbox = null;
let nukeTimer = null;

// Utility function that synchronously reads local resource from the given
// `uri` and returns content string.
function readURI(uri) {
  let ioservice = Cc['@mozilla.org/network/io-service;1'].
    getService(Ci.nsIIOService);
  let channel = ioservice.newChannel(uri, 'UTF-8', null);
  let stream = channel.open();

  let cstream = Cc['@mozilla.org/intl/converter-input-stream;1'].
    createInstance(Ci.nsIConverterInputStream);
  cstream.init(stream, 'UTF-8', 0, 0);

  let str = {};
  let data = '';
  let read = 0;
  do {
    read = cstream.readString(0xffffffff, str);
    data += str.value;
  } while (read != 0);

  cstream.close();

  return data;
}

// We don't do anything on install & uninstall yet, but in a future
// we should allow add-ons to cleanup after uninstall.
function install(data, reason) {}
function uninstall(data, reason) {}

function startup(data, reasonCode) {
  try {
    let reason = REASON[reasonCode];
    // URI for the root of the XPI file.
    // 'jar:' URI if the addon is packed, 'file:' URI otherwise.
    // (Used by l10n module in order to fetch `locale` folder)
    let rootURI = data.resourceURI.spec;

    // TODO: Maybe we should perform read harness-options.json asynchronously,
    // since we can't do anything until 'sessionstore-windows-restored' anyway.
    let manifest, options;
    let isNative = false;
    try {
      options = JSON.parse(readURI(rootURI + './harness-options.json'));
      manifest = options.manifest;
    } catch (e) {
      manifest = JSON.parse(readURI(rootURI + './package.json'));
      try {
        options = JSON.parse(readURI(rootURI + './config.json'));
      } catch (e) {
        options = {};
      }
      isNative = true;
    }

    let id = isNative ?
      (manifest.id || (~manifest.name.indexOf('@') ?
        manifest.name :
        manifest.name + '@jetpack')) :
      options.jetpackID;
    let name = isNative ? manifest.name : options.name;

    if (!isNative) {
      // Clean the metadata
      options.metadata[name]['permissions'] = options.metadata[name]['permissions'] || {};

      // freeze the permissionss
      Object.freeze(options.metadata[name]['permissions']);
      // freeze the metadata
      Object.freeze(options.metadata[name]);
    }

    // Register a new resource 'domain' for this addon which is mapping to
    // XPI's `resources` folder.
    // Generate the domain name by using jetpack ID, which is the extension ID
    // by stripping common characters that doesn't work as a domain name:
    let uuidRe =
      /^\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}$/;

    let domain = id.
      toLowerCase().
      replace(/@/g, '-at-').
      replace(/\./g, '-dot-').
      replace(uuidRe, '$1');

    let prefixURI = 'resource://' + domain + '/';
    let resourcesURIPath = isNative ? rootURI + '/' : rootURI + '/resources/';
    let resourcesURI = ioService.newURI(resourcesURIPath, null, null);
    resourceHandler.setSubstitution(domain, resourcesURI);

    // Create path to URLs mapping supported by loader.
    let addonPath = isNative ? prefixURI : prefixURI + name + '/lib/';
    let testPath = isNative ? prefixURI : prefixURI + name + '/tests/';
    let paths = {
      // Relative modules resolve to add-on package lib
      './': addonPath,
      './tests/': testPath,
      '': 'resource://gre/modules/commonjs/'
    };

    // Maps addon lib and tests ressource folders for each package
    if (!isNative) {
      paths = Object.keys(options.metadata).reduce(function(result, name) {
        result[name + '/'] = prefixURI + name + '/lib/'
        result[name + '/tests/'] = prefixURI + name + '/tests/'
        return result;
      }, paths);
    }

    // We need to map tests folder when we run sdk tests whose package name
    // is stripped
    if (name == 'addon-sdk')
      paths['tests/'] = prefixURI + name + '/tests/';

    let useBundledSDK = options['force-use-bundled-sdk'];
    if (!useBundledSDK) {
      try {
        useBundledSDK = prefService.getBoolPref("extensions.addon-sdk.useBundledSDK");
      }
      catch (e) {
        // Pref doesn't exist, allow using Firefox shipped SDK
      }
    }

    // Starting with Firefox 21.0a1, we start using modules shipped into firefox
    // Still allow using modules from the xpi if the manifest tell us to do so.
    // And only try to look for sdk modules in xpi if the xpi actually ship them
    if (options['is-sdk-bundled'] &&
        (vc.compare(appInfo.version, '21.0a1') < 0 || useBundledSDK)) {
      // Maps sdk module folders to their resource folder
      paths[''] = prefixURI + 'addon-sdk/lib/';
      // test.js is usually found in root commonjs or SDK_ROOT/lib/ folder,
      // so that it isn't shipped in the xpi. Keep a copy of it in sdk/ folder
      // until we no longer support SDK modules in XPI:
      paths['test'] = prefixURI + 'addon-sdk/lib/sdk/test.js';
    }

    // Retrieve list of module folder overloads based on preferences in order to
    // eventually used a local modules instead of files shipped into Firefox.
    let branch = prefService.getBranch('extensions.modules.' + id + '.path');
    paths = branch.getChildList('', {}).reduce(function (result, name) {
      // Allows overloading of any sub folder by replacing . by / in pref name
      let path = name.substr(1).split('.').join('/');
      // Only accept overloading folder by ensuring always ending with `/`
      if (path) path += '/';
      let fileURI = branch.getCharPref(name);

      // On mobile, file URI has to end with a `/` otherwise, setSubstitution
      // takes the parent folder instead.
      if (fileURI[fileURI.length-1] !== '/')
        fileURI += '/';

      // Maps the given file:// URI to a resource:// in order to avoid various
      // failure that happens with file:// URI and be close to production env
      let resourcesURI = ioService.newURI(fileURI, null, null);
      let resName = 'extensions.modules.' + domain + '.commonjs.path' + name;
      resourceHandler.setSubstitution(resName, resourcesURI);

      result[path] = 'resource://' + resName + '/';
      return result;
    }, paths);

    let loaderURI;


    if (isNative) {
      let toolkitLoaderPath = 'toolkit/loader.js';
      let toolkitLoaderURI = 'resource://gre/modules/commonjs/' + toolkitLoaderPath;
      if (paths['sdk/']) { // sdk folder has been overloaded
                           // (from pref, or cuddlefish is still in the xpi)
        loaderURI = paths['sdk/'] + '../' + toolkitLoaderPath;
      }
      else if (paths['']) { // root modules folder has been overloaded
        loaderURI = paths[''] + toolkitLoaderPath;
      } else {
        loaderURI = toolkitLoaderURI;
      }
    } else {
      // Import `cuddlefish.js` module using a Sandbox and bootstrap loader.
      let cuddlefishPath = 'loader/cuddlefish.js';
      let cuddlefishURI = 'resource://gre/modules/commonjs/sdk/' + cuddlefishPath;
      if (paths['sdk/']) { // sdk folder has been overloaded
                           // (from pref, or cuddlefish is still in the xpi)
        loaderURI = paths['sdk/'] + cuddlefishPath;
      }
      else if (paths['']) { // root modules folder has been overloaded
        loaderURI = paths[''] + 'sdk/' + cuddlefishPath;
      } else {
        loaderURI = cuddlefishURI;
      }
    }

    loaderSandbox = loadSandbox(loaderURI);
    let loaderModule = loaderSandbox.exports;


    unload = loaderModule.unload;
    let loaderOptions = {
      // Flag to determine whether or not to use native-style loader or not
      // If false, will be using Cuddlefish Loader, and otherwise will be
      // using toolkit/loader with `isNative` flag true
      isNative: isNative,

      paths: paths,
      // modules manifest.
      manifest: manifest,

      // Add-on ID used by different APIs as a unique identifier.
      id: id,
      // Add-on name.
      name: name,
      // Add-on version.
      // Use `version` if available (native loader), or fall back to
      // metadata[name].version
      version: isNative ? options.version : options.metadata[name].version,
      // Add-on package descriptor.
      // Use `options` if native-loader, or metadata otherwise
      metadata: isNative ? options : options.metadata[name],
      // Add-on load reason.
      loadReason: reason,

      prefixURI: prefixURI,
      // Add-on URI.
      rootURI: isNative ? addonPath : rootURI,
      // options used by system module.
      // File to write 'OK' or 'FAIL' (exit code emulation).
      resultFile: options.resultFile,
      // Arguments passed as --static-args
      staticArgs: options.staticArgs,

      // Arguments related to test runner.
      modules: {
        '@test/options': {
          allTestModules: options.allTestModules,
          iterations: options.iterations,
          filter: options.filter,
          profileMemory: options.profileMemory,
          stopOnError: options.stopOnError,
          verbose: options.verbose,
          parseable: options.parseable,
          checkMemory: options.check_memory,
          paths: paths
        }
      }
    };

    // Manually set the loader's module cache to include itself;
    // this is due to several modules requiring 'toolkit/loader',
    // which fails due to lack of `Components`
    if (isNative)
      loaderOptions.modules['toolkit/loader'] = loaderSandbox.exports;

    let loader = loaderModule.Loader(loaderOptions);
    let { console } = Cu.import('resource://gre/modules/devtools/Console.jsm', {});
    ['rootURI', 'mapping', 'manifest', 'main'].forEach((key) => {
      console.log(key, loader[key]);
    });

    let module = loaderModule.Module(isNative ? 'toolkit/loader' : 'sdk/loader/cuddlefish', loaderURI);
    let require = loaderModule.Require(loader, module);

    // Normalize `options.mainPath` so that it looks like one that will come
    // in a new version of linker.
    //
    // For native loader, the sdk/addon/runner will call loaderModule.main
    // on loader, which will resolve the main file based off of manifest
    let main = options.mainPath;

    // Only specify prefsURI if a native-flagged addon specified it
    // in the manifest, other wise, use the default path which 
    // was created by CFX
    let prefsURI = isNative ?
      (manifest.prefs ? rootURI + manifest.prefs : undefined) :
      rootURI + '/defaults/preferences/prefs.js';

    require('sdk/addon/runner').startup(reason, {
      loader: loader,
      main: main,
      prefsURI: prefsURI
    });
  } catch (error) {
    dump('Bootstrap error: ' +
         (error.message ? error.message : String(error)) + '\n' +
         (error.stack || error.fileName + ': ' + error.lineNumber) + '\n');
    throw error;
  }
};

function loadSandbox(uri) {
  let proto = {
    sandboxPrototype: {
      loadSandbox: loadSandbox,
      ChromeWorker: ChromeWorker
    }
  };
  let sandbox = Cu.Sandbox(systemPrincipal, proto);
  // Create a fake commonjs environnement just to enable loading loader.js
  // correctly
  sandbox.exports = {};
  sandbox.module = { uri: uri, exports: sandbox.exports };
  sandbox.require = function (id) {
    if (id !== "chrome")
      throw new Error("Bootstrap sandbox `require` method isn't implemented.");

    return Object.freeze({ Cc: Cc, Ci: Ci, Cu: Cu, Cr: Cr, Cm: Cm,
      CC: bind(CC, Components), components: Components,
      ChromeWorker: ChromeWorker });
  };
  scriptLoader.loadSubScript(uri, sandbox, 'UTF-8');
  return sandbox;
}

function unloadSandbox(sandbox) {
  if ("nukeSandbox" in Cu)
    Cu.nukeSandbox(sandbox);
}

function setTimeout(callback, delay) {
  let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback({ notify: callback }, delay,
                         Ci.nsITimer.TYPE_ONE_SHOT);
  return timer;
}

function shutdown(data, reasonCode) {
  let reason = REASON[reasonCode];
  if (loader) {
    unload(loader, reason);
    unload = null;

    // Don't waste time cleaning up if the application is shutting down
    if (reason != "shutdown") {
      // Avoid leaking all modules when something goes wrong with one particular
      // module. Do not clean it up immediatly in order to allow executing some
      // actions on addon disabling.
      // We need to keep a reference to the timer, otherwise it is collected
      // and won't ever fire.
      nukeTimer = setTimeout(nukeModules, 1000);
    }
  }
};

function nukeModules() {
  nukeTimer = null;
  // module objects store `exports` which comes from sandboxes
  // We should avoid keeping link to these object to avoid leaking sandboxes
  for (let key in loader.modules) {
    delete loader.modules[key];
  }
  // Direct links to sandboxes should be removed too
  for (let key in loader.sandboxes) {
    let sandbox = loader.sandboxes[key];
    delete loader.sandboxes[key];
    // Bug 775067: From FF17 we can kill all CCW from a given sandbox
    unloadSandbox(sandbox);
  }
  loader = null;

  // both `toolkit/loader` and `system/xul-app` are loaded as JSM's via
  // `cuddlefish.js`, and needs to be unloaded to avoid memory leaks, when
  // the addon is unload.

  unloadSandbox(loaderSandbox.loaderSandbox);
  unloadSandbox(loaderSandbox.xulappSandbox);

  // Bug 764840: We need to unload cuddlefish otherwise it will stay alive
  // and keep a reference to this compartment.
  unloadSandbox(loaderSandbox);
  loaderSandbox = null;
}
