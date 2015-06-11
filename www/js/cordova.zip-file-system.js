'use strict';

(function(global) {
  if (!global.zip) {
    throw 'zip library is unavailable - cannot continue';
  }

  var zip = global.zip;

  var CordovaZipFileSystem = {
    platform: {
      initialise: initPlatformSpecificFunctions,
    },
    directory: {
      make: mkdirp,
      makeTree: treeMkdir,
    },
    file: {
      getEntry: getDataFile,
      read: readFile,
      write: writeFile,
    },
    zip: {
      getReader: getZipReader,
      getWriter: getZipWriter,
      extractToFolder: extractZipToFolder,
      downloadAndExtractToFolder: downloadAndExtractZipToFolder,
      inflateEntries: zipInflateEntries,
      inflate: extractZip,
    },
  };

  global.CordovaZipFileSystem = CordovaZipFileSystem;

  // Generic error handler
  //TODO rpelace usages of this with specific error handler for each usage
  function onFail(err) {
    console.log(err);
    throw err;
  }

  function downloadAndExtractZipToFolder(options, onDone) {
    console.log('downloadAndExtractZip', options);

    if (options.readerUrl) {
      var downloadFileOnlyName = (options.readerUrl.replace( /^.*\// , ''));
      var downloadFilePath = options.downloadFolder+'/'+downloadFileOnlyName;
      if (typeof options.downloadCachedUntil === 'number' &&
          Date.now() < options.downloadCachedUntil) {
        // The current time is earlier than the cached date
        // So simply find the existing one and re-use it.
        // If not found in `options.downloadFolder`, however, we have to download it
        readFile({
          name: downloadFilePath,
          flags: {
            create: false,
            exclusive: false,
          },
          method: 'readAsArrayBuffer',
        }, function onReadFile(err, evt) {
          if (!!err) {
            console.log('re-use cached file failed for', downloadFilePath);
            downloadTheFile();
          }
          else {
            console.log('re-use cached file for', downloadFilePath);
            var blob = new global.Blob([evt.target.result], { type: zip.getMimeType(downloadFilePath) });
            options.readerBlob = blob;
            options.readerType = 'BlobReader';
            options.readerUrl = undefined;
            extractZipToFolder(options, onDone);
          }
        });
      }
      else {
        downloadTheFile();
      }

    }
    else {
      console.log('downloadAndExtractZipToFolder called without options.readerUrl');
      extractZipToFolder(options, onDone);
    }

    function downloadTheFile() {
        // So we download the file
        downloadUrlAsBlob(options.readerUrl, function onGotBlob(err, blob) {
          if (!!err) {
            onFail(err);
          }

          // extraction will continue as per usual route, however,
          // in the background, also persist this file to disk
          if (options.downloadFolder) {
            writeFile({
              name: downloadFilePath,
              blob: blob,
              flags: {
                create: true,
                exclusive: false,
                mkdirp: true,
              },
            }, function onSavedDownload(err, evt, fileEntry) {
              console.log('onSavedDownload', err, evt, fileEntry);
            });
          }

          options.readerType = 'BlobReader';
          options.readerUrl = undefined;
          options.readerBlob = blob;
          extractZipToFolder(options, onDone);
        });
      }
  }

  /**
   * Opens a Zip file, and inflates all of its contents to a folder on the filesystem
   * Combines `extractZip` and `writeFile` functionality,
   * adding a management layer.
   *
   * @param  {Object} options
   *   {
   *     useWebWorkers: false,
   *     workerScripts: {},
   *     readerUrl: '',
   *     extractFolder: '',
   *   }
   * @param  {Function} onDone  [description]
   */
  function extractZipToFolder(options, onDone) {
    var numFiles = 0;
    var numFilesWritten = 0;
    var numFilesErrored = 0;
    var allInflated = false;
    // Modify writer options to an intermediate format of this function's preference

    var zipOptions = {
      useWebWorkers: options.useWebWorkers,
      workerScripts: options.workerScripts,

      readerType: options.readerType,
      readerUrl: options.readerUrl,
      readerBlob: options.readerBlob,
      readerText: options.readerText,
      readerDataUri: options.readerDataUri,

      writerType: 'BlobWriter',

      extractFolder: options.extractFolder,
      preemptiveTreeMkdir: true,
    };
    extractZip(zipOptions, function onExtractZipDone(err, allDone, fileInfo) {
      if (!!err) {
        throw err;
      }
      if (!allDone) {
        // Signalled that a single file in the zip file has been inflated, and here it is

        // Modify writer options to write to the file system
        var fileOptions = {
          name: options.extractFolder+'/'+fileInfo.fileEntry.filename,
          flags: {
            create: true,
            exclusive: false,
            mkdirp: false,
          },
          blob: fileInfo.contents,
        };

        ++numFiles;
        writeFile(fileOptions, function onWriteFileDone(err, evt, fileEntry) {
          if (!!err) {
            ++numFilesErrored;
            onFail(err);
          }

          ++numFilesWritten;
          console.log('File written:', fileInfo,
            'numFilesWritten:', numFilesWritten,
            'evt.target.localURL:', evt.target.localURL,
            'fileEntry.toURL()', fileEntry.toURL()
            );
          checkComplete();
        });
      }
      else {
        // Signalled that all files in the zip file have been inflated
        allInflated = true;
        checkComplete();
      }
      function checkComplete() {
        if (allInflated && numFilesWritten + numFilesErrored >= numFiles) {
          var error;
          if (numFilesErrored > 0) {
            error = 'Number of files errored: '+numFilesErrored;
          }
          onDone(error, numFilesWritten);
        }
      }
    });
  }

  /**
   * Downloads a file at given URL and calls back with it as a Blob
   *
   * @param  {String} url    URL of the file to be downloaded
   * @param  {Function} onDone Parameters: error, blob
   */
  function downloadUrlAsBlob(url, onDone) {
    console.log('downloadUrlAsBlob', url);
    var xhr = new global.XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onreadystatechange = onXhrStateChange;
    xhr.send(null);

    function onXhrStateChange() {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          // Success
          console.log('success downloadUrlAsBlob', xhr.response);
          var blob = new global.Blob([xhr.response], { type: zip.getMimeType(url) });
          onDone(undefined, blob);
        }
        else {
          // Error
          console.log('failure downloadUrlAsBlob', xhr);
          onDone(xhr, xhr.status);
        }
      }
    }
  }

  var MAX_CONCURRENT_INFLATE = 512;
  var MAX_CONCURRENT_SIZE_COST = 2 * 1024 * 1024;

  /**
   * Inflate a list of zip entries.
   * Inflation is asynchronous, and this function rate limits to adhere to
   * a maximum number of concurrent entries being extracted,
   * as well as a maximum concurrent extraction cost.
   *
   * Extraction cost is proportional to the uncompressed size
   * multiplied by the compression ratio (uncompressed size divided by compressed size)
   *
   * @param  {Object} options   [description]
   * @param  {Array<zip.Entry>} entries   [description]
   * @param  {Function} onInflate [description]
   */
  function zipInflateEntries(options, entries, onInflate) {
    console.log(options.name, 'entries.length:', entries.length);
    var resultCount = entries.length;
    var concurrentEntries = 0;
    var concurrentCost = 0;
    var entryIndex = 0;

    function doNextEntry() {
      if (entryIndex >= entries.length) {
        return;
      }
      var entry = entries[entryIndex];
      var estimatedSizeCost =
        entry.uncompressedSize * (entry.uncompressedSize / entry.compressedSize);
      ++entryIndex;
      ++concurrentEntries;
      concurrentCost += estimatedSizeCost;

      var writer = getZipWriter(options, entry);
      entry.getData(writer, function onGotDataForZipEntry(data) {
        onInflate(undefined, false, {
          fileEntry: entry,
          contents: data,
        });

        --concurrentEntries;
        --resultCount;
        concurrentCost -= estimatedSizeCost;
        if (resultCount < 1) {
          onInflate(undefined, true);
        }
        else {
          doRateLimitedNextEntries();
        }
      });
    }

    // In V8, if we spawn too many CPU intensive callback functions
    // at once, it is smart enough to rate limit it automatically
    // This, however, is not the case for other Javascript VMs,
    // so we need to implement by hand a means to
    // limit the max number of concurrent operations
    function doRateLimitedNextEntries() {
      while ( entryIndex < entries.length &&
              (concurrentEntries < 1 ||
               (concurrentEntries <= MAX_CONCURRENT_INFLATE &&
                concurrentCost <= MAX_CONCURRENT_SIZE_COST))) {
        doNextEntry();
      }
    }

    doRateLimitedNextEntries();
  }

  /**
   * Inflate a zip file
   *
   * @param  {Object} options [description]
   * @param  {Function} onDone  [description]
   */
  function extractZip(options, onDone) {
    zip.useWebWorkers = options.useWebWorkers;
    zip.workerScripts = options.workerScripts;

    var reader = getZipReader(options);

    zip.createReader(reader, function onZipReaderCreated(zipReader) {
      zipReader.getEntries(function onZipEntriesListed(entries) {
        entries = entries.filter(function(entry) {
          return !entry.directory;
        });
        if (!!options.preemptiveTreeMkdir) {
          // Preemptively construct all of the required directories
          // to avoid having to do this repetitively as each file is written
          var dirs = entries.map(function dirOfFile(entry) {
            return options.extractFolder+'/'+entry.filename.replace( /\/[^\/]+$/ , '');
          });
          treeMkdir(dirs, function onCompleteRootTree(errors) {
            // console.log('mkdir tree completed', 'completed', completedSubTrees, '/', totalSubTrees, 'errors:', errors);
            console.log('mkdir tree completed', 'errors:', errors);
            zipInflateEntries(options, entries, onDone);
          });
        }
        else {
          zipInflateEntries(options, entries, onDone);
        }
      });
    }, function onZipReaderCreateFailed(err) {
      if (!!err) {
        onFail(err);
      }
    });
  }

  function getDataFile(path, options, onGotFileEntry) {
    options = options || {};
    getFileSystemRoot(function onGotFileSytemRoot(fsRoot) {
      // console.log('fileSys:', fileSys);
      if (!!options.mkdirp) {
        var dirPath = path.replace( /\/[^\/]+$/ , '');
        mkdirp(fsRoot, dirPath, function onMkdirpDone(err, dirEntry) {
          if (!!err) {
            onFail(err);
          }
          continueGetDataFile();
        });
      }
      else {
        continueGetDataFile();
      }
      function continueGetDataFile() {
        createFile(fsRoot, path, options, function onGotFileEntryImpl(fileEntry) {
          // console.log('fileEntry:', fileEntry);
          onGotFileEntry(undefined, fileEntry);
        }, onFail);
      }
    });
  }

  function writeFile(options, onDone) {
    getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
      if (!!err) {
        onFail(err);
      }
      var blob;
      if (options.blob) {
        blob = options.blob;
      }
      else if (options.content && options.mimeType) {
        blob = new global.Blob([options.contents], { type: options.mimeType });
      }
      else {
        throw 'Cannot create file, invalid options';
      }

      writeBlobToFile(fileEntry, blob, onDone);
    }, onFail);
  }

  function readFile(options, onDone) {
    getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
      if (!!err) {
        onFail(err);
      }
      readFileImpl(fileEntry, options, onDone);
    }, onFail);
  }

  /**
   * Make a directory recursively
   *
   * @param  {DirectoryEntry}   fsRoot File system root:
   *   http://docs.phonegap.com/en/edge/cordova_file_file.md.html#DirectoryEntry
   *   http://docs.phonegap.com/en/edge/cordova_file_file.md.html#FileSystem
   * @param  {String} path      The path of the directory, relative to file system root
   * @param  {Function} onDone  Callback
   */
  function mkdirp(fsRoot, path, onDone) {
      var dirs = path.split('/').reverse();

      function mkdirSub() {
        if (dirs.length > 0) {
          mkdir(fsRoot, dirs.pop(), onCreateDirSuccess, onCreateDirFailure);
        } else {
          console.log('mkdir -p OK', path);
          onDone(undefined, path);
        }
      }

      function onCreateDirSuccess(dirEntry) {
        // console.log('mkdir OK ', dirEntry.fullPath);
        fsRoot = dirEntry;
        mkdirSub();
      }

      function onCreateDirFailure(err) {
        console.log('mkdir fail', err, !!err && err.stack);
        throw err;
      }

      mkdir(fsRoot, dirs.pop(), onCreateDirSuccess, onCreateDirFailure);
  }

  function constructTreeFromListOfDirectories(dirs) {
    var tree = {};
    dirs.forEach(function addToTree(dir) {
      var node = tree;
      var segments = dir.split('/');
      for (var i = 0; i < segments.length; ++i) {
        var segment = segments[i];
        if (!node[segment]) {
          node[segment] = {};
        }
        node = node[segment];
      }
    });
    return tree;
  }

  /**
   * Make a list of directories efficiently,
   * by constructing a tree data structure
   *
   * @param  {Array<String>}  dirs               A list of directories that need to be constructed
   * @param  {Function}       onCompleteRootTree Gets called once complete, the first parameter will be an array of errors
   */
  function treeMkdir(dirs, onCompleteRootTree) {
    var tree = constructTreeFromListOfDirectories(dirs);

    getFileSystemRoot(onGotFileSytem);

    function onGotFileSytem(fileSys) {
      // Now recur through the nodes in the tree, breadth-first search,
      // and mkdir each node in turn
      // This ensures that the minimum number of mkdirs is needed
      var errors = [];

      mkdirTree('', tree, onCompleteRootTree);

      function mkdirTree(path, node, onCompleteTree) {
        var subDirs = Object.keys(node);
        var numSubDirs = subDirs.length;

        if (numSubDirs === 0) {
          // Termination condition
          onCompleteTree();
          return;
        }

        var numLocalAttempts = 0;

        subDirs.forEach(function eachSubDir(subDir) {
          var subDirPath = (path.length > 0) ? path+'/'+subDir : subDir;
          var subNode = node[subDir];

          mkdir(fileSys, subDirPath, function onCreateDirSuccess(dirEntry) {
            // Recur
            mkdirTree(subDirPath, subNode, function onCompleteSubTree() {
              ++numLocalAttempts;
              if (numLocalAttempts >= numSubDirs) {
                onCompleteTree(errors);
              }
            });
          }, function onCreateDirFailure(err) {
            ++numLocalAttempts;
            errors.push({
              err: err,
              path: path,
              subDir: subDir,
            });
            if (numLocalAttempts >= numSubDirs) {
              onCompleteTree(errors);
            }
          });
        });
      }
    }
  }

  function getZipReader(options) {
    var reader;
    switch (options.readerType) {
      case 'TextReader':
        reader = new zip.TextReader(options.readerText);
        break;
      case 'BlobReader':
        reader = new zip.BlobReader(options.readerBlob);
        break;
      case 'Data64URIReader':
        reader = new zip.Data64URIReader(options.readerDataUri);
        break;
      case 'HttpReader':
        reader = new zip.HttpReader(options.readerUrl);
        break;
      case 'HttpRangeReader':
        reader = new zip.HttpRangeReader(options.readerUrl);
        break;
      default:
        throw 'Unrecognised zip reader type: '+options.readerType;
    }
    return reader;
  }

  function getZipWriter(options, fileEntry) {
    var writer;
    switch (options.writerType) {
      case 'TextWriter':
        writer = new zip.TextWriter();
        break;
      case 'BlobWriter':
        writer = new zip.BlobWriter(zip.getMimeType(fileEntry.fileName));
        break;
      case 'FileWriter':
        writer = new zip.FileWriter(fileEntry);
        break;
      case 'Data64URIWriter':
        writer = new zip.Data64URIWriter(zip.getMimeType(fileEntry.fileName));
        break;
      default:
        throw 'Unrecognised zip writer type: '+options.writerType;
    }
    return writer;
  }

  /*
   * Platform-specific functions
   * Because Windows Phone Universal apps(*.appx) do not support the
   * Cordova file system API
   */

  //NOTE this is the closest we get to #IFDEF style conditional compilation
  var getFileSystemRoot, mkdir, createFile, writeBlobToFile, readFileImpl;
  function initPlatformSpecificFunctions() {
    if (!!global.device &&
        global.device.available &&
        typeof global.device.platform === 'string' &&
        global.device.platform.toLowerCase() === 'windows') {
      getFileSystemRoot = _windows_getFileSystemRoot;
      mkdir = _windows_mkdir;
      createFile = _windows_createFile;
      writeBlobToFile = _windows_writeBlobToFile;
      readFileImpl = _windows_readFileImpl;
    }
    else {
      getFileSystemRoot = _regular_getFileSystemRoot;
      mkdir = _regular_mkdir;
      createFile = _regular_createFile;
      writeBlobToFile = _regular_writeBlobToFile;
      readFileImpl = _regular_readFileImpl;
    }
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

  function _regular_mkdir(fsRoot, dirPath, onCreateDirSuccess, onCreateDirFailure) {
    // console.log('mkdir', dirPath);
    fsRoot.getDirectory(dirPath, {
      create : true,
      exclusive : false,
    }, onCreateDirSuccess, onCreateDirFailure);
  }

  function _windows_mkdir(fsRoot, dirPath, onCreateDirSuccess, onCreateDirFailure) {
    // console.log('mkdir-windows', dirPath);
    fsRoot
      .createFolderAsync(dirPath, global.Windows.Storage.CreationCollisionOption.openIfExists)
      .then(onCreateDirSuccess, onCreateDirFailure);
  }

  function _regular_createFile(fsRoot, path, options, onGotFileEntry, onFailToGetFileEntry) {
    fsRoot.getFile(path, options, onGotFileEntry, onFailToGetFileEntry);
  }

  function _windows_createFile(fsRoot, path, options, onGotFileEntry, onFailToGetFileEntry) {
    if (!!options.create) {
      var windowsFlag;
      if (!!options.exclusive) {
        windowsFlag = global.Windows.Storage.CreationCollisionOption.failIfExists;
      }
      else {
        windowsFlag = global.Windows.Storage.CreationCollisionOption.openIfExists;
      }
      fsRoot
        .createFileAsync(path, windowsFlag)
        .then(onGotFileEntry, onFailToGetFileEntry);
    }
    else {
      //read
      fsRoot.
        getFileAsync(path)
        .then(onGotFileEntry, onFailToGetFileEntry);
    }
  }

  function _regular_writeBlobToFile(fileEntry, blob, onDone) {
    fileEntry.createWriter(function onWriterCreated(writer) {
      writer.onwriteend = onWrote;
      writer.write(blob);

      function onWrote(evt) {
        onDone(writer.error, evt, fileEntry);
      }
    }, onFail);
  }

  function _windows_writeBlobToFile(fileEntry, blob, onDone) {
    var blobStream = blob.msDetachStream();
    Windows.Storage.Streams.RandomAccessStream
      .copyAsync(blobStream, fileEntry)
      .then(function onWrote() {
          fileEntry
            .flushAsync()
            .done(function onFlushed() {
              blobStream.close();
              fileEntry.close();
              onDone(undefined, { target: fileEntry }, fileEntry);
            }, onFail);
        }, onFail);
  }

  function _regular_readFileImpl(fileEntry, options, onDone) {
    fileEntry.file(function onGotFile(file) {
      var reader = new global.FileReader();
      reader.onloadend = onRead;

      var method;
      switch (options.method) {
        case 'readAsText':
        case 'readAsDataURL':
        case 'readAsBinaryString':
        case 'readAsArrayBuffer':
          method = options.method;
          break;
        default:
          throw 'Unrecognised file reader method: '+ options.method;
      }
      reader[method](file);

      function onRead(evt) {
        onDone(reader.error, evt);
      }
    }, onFail);
  }

  function _windows_readFileImpl(fileEntry, options, onDone) {
    var method;
    switch (options.method) {
      case 'readAsText':
        method = 'readTextAsync';
        break;
      case 'readAsDataURL':
        throw 'DataURL unsupported on Windows';
      case 'readAsBinaryString':
        throw 'BinaryString unsupported on Windows';
      case 'readAsArrayBuffer':
        method = 'ReadBufferAsync';
        break;
      default:
        throw 'Unrecognised file reader method: '+ options.method;
      }
    Windows.Storage.FileIO
      [method](fileEntry)
      .then(function onRead(contents) {
        onDone(undefined, contents);
      }, onFail);
  }
})(this);

