'use strict';

(function(global) {
  if (!global.zip) {
    throw 'zip library is unavailable - cannot continue';
  }

  var zip = global.zip;

  var CordovaZipFileSystem = {
    platform: {
      initialise: platform_initialise,
    },
    directory: {
      makeRecursive: directory_makeRecursive,
      makeTree: directory_makeTree,
      copyRecursive: directory_copyRecursive,
    },
    file: {
      getEntry: file_getEntry,
      read: file_read,
      write: file_write,
    },
    zip: {
      getReader: zip_getReader,
      getWriter: zip_getWriter,
      extract: zip_extract,
      downloadAndExtract: zip_downloadAndExtract,
      inflateEntries: zip_inflateEntries,
      inflate: zip_inflate,
    },
  };

  global.CordovaZipFileSystem = CordovaZipFileSystem;

  function zip_downloadAndExtract(options, onDone) {
    console.log('zip_downloadAndExtract', options);
    // Ultimately calls `zip_extract()`

    if (options.readerUrl) {
      if (!!options.cdnStyle) {
        // Let's say `readerUrl` is `http://cdn.com/foo/bar/baz.zip`
        // and `downloadFolder` is `cdn-zipped`
        // and `extractFolder` is `cdn-unzipped`;
        // the file should be downloaded to `cdn-zipped/cdn.com/foo/bar/baz.zip`
        // the file should be extracted to `cdn-unzipped/cdn.com/foo/bar/baz.zip/*`
        var filePath = options.readerUrl.replace( /^[^\:]+\:\/\// , '');
        options.extractFolder = options.extractFolder+'/'+filePath;
        options.downloadFilePath = options.downloadFolder+'/'+filePath;
      }
      else {
        // If not CDN style, file is downloaded directly to the `downloadFolder`
        // and unzipped directly in the `extractFolder`
        var downloadFileOnlyName = (options.readerUrl.replace( /^.*\// , ''));
        options.downloadFilePath = options.downloadFolder+'/'+downloadFileOnlyName;
      }

      var attemptUseCache =
        (typeof options.downloadCachedUntil !== 'number') ||
        (typeof options.downloadCachedUntil === 'number' &&
          Date.now() < options.downloadCachedUntil);
      if (attemptUseCache) {
        // The current time is earlier than the cached date,
        // Or none has been specified (so always use cache) 
        // So simply find the existing one and re-use it.
        // If not found in `options.downloadFolder`, however, we have to download it
        attemptToGetFileFromCache(options, onDone);
      }
      else {
        downloadFileAsBlobAndPersist(options, onDone);
      }
    }
    else {
      console.log('zip_downloadAndExtract called without options.readerUrl');
      zip_extract(options, onDone);
    }
  }

  function attemptToGetFileFromCache(options, onDone) {
    file_read({
      name: options.downloadFilePath,
      flags: {
        create: false,
        exclusive: false,
      },
      method: 'readAsArrayBuffer',
    }, function onReadFile(err, contents) {
      if (!!err || !contents) {
        console.log('failed to re-use cached file for', options.downloadFilePath);
        downloadFileAsBlobAndPersist(options, onDone);
      }
      else {
        console.log('re-use cached file for', options.downloadFilePath);
        var blob = new global.Blob([contents], { type: zip.getMimeType(options.downloadFilePath) });
        options.readerBlob = blob;
        options.readerType = 'BlobReader';
        options.readerUrl = undefined;
        zip_extract(options, onDone);
      }
    });
  }

  function downloadFileAsBlobAndPersist(options, onDone, onPersist) {
    // So we download the file
    downloadUrlAsBlob(options.readerUrl, function onGotBlob(err, blob) {
      if (!!err) {
        onDone(err);
        return
      }

      // Extract the blob while still in memory
      options.readerType = 'BlobReader';
      options.readerUrl = undefined;
      options.readerBlob = blob;
      zip_extract(options, completeBlob);

      function completeBlob(err, data) {
        if (!!err) {
          onDone(err);
          return;
        }
        if (options.downloadFolder) {
          // After file has been extracted, persist the original file back to disk
          file_write({
            name: options.downloadFilePath,
            blob: blob,
            flags: {
              create: true,
              exclusive: false,
              mkdirp: true,
            },
          }, onDone);
        }
        else {
          onDone(err, data);
        }
      }
    });
  }

  /**
   * Opens a Zip file, and inflates all of its contents to a folder on the filesystem
   * Combines `zip_inflate` and `file_write` functionality,
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
  function zip_extract(options, onDone) {
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
      processEmptyZipEntry: options.processEmptyZipEntry,
    };

    zip_inflate(zipOptions, function onExtractZipDone(err, allDone, fileInfo) {
      if (!!err) {
        onDone(err);
        return;
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
        file_write(fileOptions, function onWriteFileDone(err, fileEntry, evt) {
          if (!!err) {
            ++numFilesErrored;
            onDone(err);
            return;
          }

          ++numFilesWritten;
          console.log('File written:', fileInfo,
            'numFilesWritten:', numFilesWritten,
            // 'evt.target.localURL:', evt.target.localURL,
            'urlOfFileEntry(fileEntry)', urlOfFileEntry(fileEntry)
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
          if (!blob || !blob.size) {
            onDone('Downloaded blob is empty');
            return;
          }
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
  function zip_inflateEntries(options, entries, onInflate) {
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

      var processEmptyZipEntry;
      if (typeof options.processEmptyZipEntry === 'function') {
        processEmptyZipEntry = options.processEmptyZipEntry;
      }
      else {
        processEmptyZipEntry = defaultProcessEmptyZipEntry;
      }

      if (entry.uncompressedSize === 0) {
        // This is an empty file - allow overwrite the file contents
        ++entryIndex;
        ++concurrentEntries;
        // `concurrentCost` impact is estimated to be negligible
        processEmptyZipEntry(entry, function onProcessedEmptyZipEntry(err, data) {
          onInflate(undefined, false, {
            fileEntry: entry,
            contents: data,
          });
          completeSingleFile();
        });
        return;
      }

      var estimatedSizeCost =
        entry.uncompressedSize * (entry.uncompressedSize / entry.compressedSize);
      ++entryIndex;
      ++concurrentEntries;
      concurrentCost += estimatedSizeCost;

      var writer = zip_getWriter(options, entry);
      entry.getData(writer, function onGotDataForZipEntry(data) {
        if ((options.writerType === 'BlobWriter' && data.size !== entry.uncompressedSize) ||
            (options.writerType === 'Data64URIWriter' && data.length < entry.uncompressedSize)) {
          onInflate('Inflated data is not the right size');
          return;
        }
        onInflate(undefined, false, {
          fileEntry: entry,
          contents: data,
        });
        
        concurrentCost -= estimatedSizeCost;
        completeSingleFile();
      });
    }

    function completeSingleFile() {
      --concurrentEntries;
      --resultCount;
      if (resultCount < 1) {
        onInflate(undefined, true);
      }
      else {
        doRateLimitedNextEntries();
      }
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
  function zip_inflate(options, onDone) {
    zip.useWebWorkers = options.useWebWorkers;
    zip.workerScripts = options.workerScripts;

    var reader = zip_getReader(options);

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
          directory_makeTree(dirs, function onCompleteRootTree(errors) {
            // console.log('mkdir tree completed', 'completed', completedSubTrees, '/', totalSubTrees, 'errors:', errors);
            console.log('mkdir tree completed', 'errors:', errors);
            zip_inflateEntries(options, entries, onDone);
          });
        }
        else {
          zip_inflateEntries(options, entries, onDone);
        }
      });
    }, onDone);
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

  function file_getEntry(path, options, onGotFileEntry) {
    options = options || {};
    getFileSystemRoot(function onGotFileSytemRoot(fsRoot) {
      // console.log('fileSys:', fileSys);
      if (!!options.mkdirp) {
        var dirPath = path.replace( /\/[^\/]+$/ , '');
        directory_makeRecursive(fsRoot, dirPath, function onMkdirpDone(err, dirEntry) {
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
        getFile(fsRoot, path, options, function onGotFileEntryImpl(fileEntry) {
          // console.log('fileEntry:', fileEntry);
          onGotFileEntry(undefined, fileEntry);
        }, onGotFileEntry);
      }
    });
  }

  function _regular_getFile(fsRoot, path, options, onGotFileEntry, onFailToGetFileEntry) {
    fsRoot.getFile(path, options, onGotFileEntry, onFailToGetFileEntry);
  }

  function _windows_getFile(fsRoot, path, options, onGotFileEntry, onFailToGetFileEntry) {
    path = path.replace( /\//g , '\\');
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
            fsRoot
                .tryGetItemAsync(path)
                .done(function fileExists(file) {
                    if (!!file) {
                        fsRoot.getFileAsync(path).then(onGotFileEntry, onFailToGetFileEntry);
                    }
                    else {
                        onFailToGetFileEntry('No file found at path: ' + path);
                    }
                }, onFailToGetFileEntry);
       //     fsRoot.
       // getFileAsync(path)
       // .then(onGotFileEntry, onFailToGetFileEntry);
      
    }
  }

  function file_write(options, onDone) {
    var blob;
    if (options.blob) {
      blob = options.blob;
    }
    else if (options.contents && options.mimeType) {
      blob = new global.Blob([options.contents], { type: options.mimeType });
    }
    else {
      onDone('Cannot create file: Invalid options');
    }
    if (!blob || !blob.size) {
      onDone('Cannot create file: Trying to write an empty blob');
    }

    file_getEntry(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
      if (!!err) {
        onFail(err);
      }

      writeBlobToFile(fileEntry, blob, onDone);
    }, onFail);
  }

  function _regular_writeBlobToFile(fileEntry, blob, onDone) {
    if (!blob || !blob.size) {
        onDone('Empty blob');
    }
    fileEntry.createWriter(function onWriterCreated(writer) {
      writer.onwriteend = onWrote;
      writer.write(blob);

      function onWrote(evt) {
        onDone(writer.error, fileEntry, evt);
      }
    }, onFail);
  }

  function _windows_writeBlobToFile(fileEntry, blob, onDone) {
    if (!blob || !blob.size) {
        onDone('Empty blob');
    }
    var blobStream = blob.msDetachStream();
    var outputFile;
    fileEntry
      .openAsync(Windows.Storage.FileAccessMode.readWrite)
      .then(function openedFileForWriting(outFile) {
          outputFile = outFile;
        return Windows.Storage.Streams.RandomAccessStream
          .copyAsync(blobStream, outFile);
      }, onFail)
      .then(function onFileWritten() {
          return outputFile
            .flushAsync();
      }, onFail)
      .then(function onFileFlushed() {
          blobStream.close();
          outputFile.close();
          onDone(undefined, fileEntry);
      }, onFail);
  }


  function file_read(options, onDone) {
    file_getEntry(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
      if (!!err) {
          onDone(err);
          return;
      }
      readFileImpl(fileEntry, options, onDone);
    }, onDone);
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
        if (!evt || !evt.target || !evt.target.result) {
          onDone('No result after file read', undefined, evt);
        }
        else {
          onDone(reader.error, evt.target.result, evt);
        }
      }
    }, onDone);
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
        method = 'readBufferAsync';
        break;
      default:
        throw 'Unrecognised file reader method: '+ options.method;
      }
    Windows.Storage.FileIO
      [method](fileEntry)
      .then(function onRead(contents) {
        if (method === 'readBufferAsync') {
          var arrayBuffer = new Uint8Array(contents.length);
          var dataReader = Windows.Storage.Streams.DataReader.fromBuffer(contents);
          dataReader.readBytes(arrayBuffer);
          dataReader.close();
          onDone(undefined, arrayBuffer);
        }
        else {
          onDone(undefined, contents);
        }
      }, onDone);
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
  function directory_makeRecursive(fsRoot, path, onDone) {
      var dirs = path.split('/').reverse();

      function mkdirSub(dirEntry) {
        if (dirs.length > 0) {
          mkdir(fsRoot, dirs.pop(), onCreateDirSuccess, onCreateDirFailure);
        }
        else {
          console.log('mkdir -p OK', path, dirEntry);
          onDone(undefined, dirEntry);
        }
      }

      function onCreateDirSuccess(dirEntry) {
        // console.log('mkdir OK ', dirEntry.fullPath);
        fsRoot = dirEntry;
        mkdirSub(dirEntry);
      }

      function onCreateDirFailure(err) {
        console.log('mkdir fail', err, !!err && err.stack);
        throw err;
      }

      mkdir(fsRoot, dirs.pop(), onCreateDirSuccess, onCreateDirFailure);
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
    dirPath = dirPath.replace( /\//g , '\\');
    fsRoot
      .createFolderAsync(dirPath, global.Windows.Storage.CreationCollisionOption.openIfExists)
      .then(onCreateDirSuccess, onCreateDirFailure);
  }

  function directory_copyRecursive(fsRootSource, source, fsRootDest, dest, onDone) {
    var numFods = 0;
    var numWritten = 0;
    var numErrored = 0;
    var replaceFlag = Windows.Storage.CreationCollisionOption.replaceExisting;

    fsRootSource
      .getFolderAsync(source)
      .then(function onGotSourceDir(srcDir) {
        directory_makeRecursive(fsRootDest, dest, function onMkdirpDest(err, dirEntry) {
          if (!!err) {
            onDone(err);
            return;
          }
          copyFolders(srcDir);
        });
      })
    .then(undefined, function onErr(err) {
      console.error('Err:', err);
    });

    function copyFolders(from) {
      if (!from) {
        throw 'Invalid from directory';
      }

      var checkedFiles = false;
      var checkedFolders = false;
      copySubFiles();
      copySubFolders();

      function copySubFiles() {
        from
        .getFilesAsync()
        .then(function onGotFiles(files) {
          checkedFiles = true;
          if (!!files) {
            numFods += files.length;
            files.forEach(function onFile(result) {
              console.log("copy file: " + result.displayName);
              result
                .copyAsync(destFolder)
                .then(function onFileCopied() {
                  ++numWritten
                  checkComplete();
                }, function onFileCopyError(err) {
                  console.error('Err', err);
                  ++numErrored;
                });
            });
          }
        }, function onFileCopyError(err) {
          console.error('Err', err);
        });
      }

      function copySubFolders() {
        from
        .getFoldersAsync()
        .then(function onGotFolders(folders) {
          checkedFolders = true;
          numFods += folders.length;
          if (folders.length === 0) {
            checkComplete();
          }
          folders.forEach(function onFolder(folder) {
            console.log('create folder: ' + folder.name);
            destFolder
              .createFolderAsync(folder.name, replaceFlag)
              .then(function onCreatedParallelFolder(newFolder) {
                ++numWritten;
                copyFolders(folder, newFolder);
                checkComplete();
              }, function onFolderCreateError(err) {
                console.error('Err', err);
                ++numErrored;
              });
          });
        }, function onGotFoldersError(err) {
          console.error('Err', err);
        });
      }

      function checkComplete() {
        if (checkedFiles &&
          checkedFolders &&
          numWritten + numErrored >= numFods) {
          var err;
          if (numErrored > 0) {
            err = 'Number of files or directories errored: ' + numErrored;
          }
          onDone(err, numWritten);
        }
      }

    }

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
  function directory_makeTree(dirs, onCompleteRootTree) {
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

  function zip_getReader(options) {
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

  function zip_getWriter(options, zipEntry) {
    var writer;
    switch (options.writerType) {
      case 'TextWriter':
        writer = new zip.TextWriter();
        break;
      case 'BlobWriter':
        writer = new zip.BlobWriter(zip.getMimeType(zipEntry.fileName));
        break;
      case 'FileWriter':
        writer = new zip.FileWriter(options.writerFileEntry);
        break;
      case 'Data64URIWriter':
        writer = new zip.Data64URIWriter(zip.getMimeType(zipEntry.fileName));
        break;
      default:
        throw 'Unrecognised zip writer type: '+options.writerType;
    }
    return writer;
  }

  function defaultProcessEmptyZipEntry(entry, onProcessedEmptyZipEntry) {
    var replacementContents;
    var mimeType = zip.getMimeType(entry.filename);
    switch (mimeType) {
      case 'text/html':
      case 'application/xml':
        replacementContents = '<!-- ' + entry.filename + ' -->';
        break;
      default:
        replacementContents = '// ' + entry.filename + '\n';
    }
    onProcessedEmptyZipEntry(undefined, new Blob([replacementContents], mimeType));
  }

  /*
   * Platform-specific functions
   * Because Windows Phone Universal apps(*.appx) do not support the
   * Cordova file system API
   */

  //NOTE this is the closest we get to #IFDEF style conditional compilation
  var urlOfFileEntry, getFileSystemRoot, getFile, writeBlobToFile, readFileImpl, mkdir;

  function platform_initialise() {
    if (!!global.device &&
        typeof global.device.platform === 'string' &&
        global.device.platform.toLowerCase() === 'windows') {
      console.log('Initialising platform-specifc functions for Windows-flavoured cordova');
      urlOfFileEntry = _windows_urlOfFileEntry;
      getFileSystemRoot = _windows_getFileSystemRoot;
      getFile = _windows_getFile;
      writeBlobToFile = _windows_writeBlobToFile;
      readFileImpl = _windows_readFileImpl;
      mkdir = _windows_mkdir;
    }
    else {
      console.log('Initialising platform-specific functions for regular cordova');
      urlOfFileEntry = _regular_urlOfFileEntry;
      getFileSystemRoot = _regular_getFileSystemRoot;
      getFile = _regular_getFile;
      writeBlobToFile = _regular_writeBlobToFile;
      readFileImpl = _regular_readFileImpl;
      mkdir = _regular_mkdir;
    }
  }

})(this);

