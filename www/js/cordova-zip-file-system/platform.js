'use strict';

(function(global) {
  if (!global.zip) {
    throw 'zip library is unavailable - cannot continue';
  }
  var zip = global.zip;

  global.CordovaZipFileSystem = global.CordovaZipFileSystem || {};

  global.CordovaZipFileSystem.platform = {
    initialise: platform_initialise,
    getCategory: platform_getCategory,
  };

  var category;

  function platform_getCategory() {
    if (!!category) {
      // Do nothing, just re-use cached value
    }
    else if (!!global.device &&
        typeof global.device.platform === 'string' &&
        global.device.platform.toLowerCase() === 'windows') {
      category = 'windows';
    }
    else {
      category = 'regular';
    }
    return category;
  }

  /*
   * Platform-specific functions
   * Because Windows Phone Universal apps(*.appx) do not support the
   * Cordova file system API
   */

  //NOTE this is the closest we get to #IFDEF style conditional compilation
  var urlOfFileEntry, getFileSystemRoot;

  function platform_initialise() {
    var platformCategory = platform_getCategory();
    if (platformCategory === 'windows') {
      console.log('Initialising platform-specifc functions for Windows-flavoured cordova');
      urlOfFileEntry = _windows_urlOfFileEntry;
      getFileSystemRoot = _windows_getFileSystemRoot;
    }
    else {
      console.log('Initialising platform-specific functions for regular cordova');
      urlOfFileEntry = _regular_urlOfFileEntry;
      getFileSystemRoot = _regular_getFileSystemRoot;
    }

    global.CordovaZipFileSystem.platform.urlOfFileEntry = urlOfFileEntry;
    global.CordovaZipFileSystem.platform.getFileSystemRoot = getFileSystemRoot;

    ['file', 'directory', 'zip'].forEach(function(moduleName) {
      if (global.CordovaZipFileSystem[moduleName] &&
          typeof global.CordovaZipFileSystem[moduleName]._initialise === 'function') {
        global.CordovaZipFileSystem[moduleName]._initialise(platformCategory);
      }
    });
  }

  function _regular_urlOfFileEntry(fileEntry) {
    return fileEntry.toURL();
  }

  function _windows_urlOfFileEntry(fileEntry) {
    return fileEntry.path;
  }

  function _regular_getFileSystemRoot(onGotFileSystem) {
    // console.log('getFileSystemRoot', dirPath);
    global.requestFileSystem(global.LocalFileSystem.PERSISTENT, 0,
      function onGotFileSytemPre(fileSys) {
        onGotFileSystem(fileSys.root);
      });
  }

  function _windows_getFileSystemRoot(onGotFileSystem) {
    // console.log('getFileSystemRoot-windows', dirPath);
    onGotFileSystem(global.Windows.Storage.ApplicationData.current.localFolder);
  }

})(this);

