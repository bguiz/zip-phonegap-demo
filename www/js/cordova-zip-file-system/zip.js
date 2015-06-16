'use strict';

(function(global) {
  if (!global.zip) {
    throw 'zip library is unavailable - cannot continue';
  }
  var zip = global.zip;

  global.CordovaZipFileSystem = global.CordovaZipFileSystem || {};

  global.CordovaZipFileSystem.zip = {
    getReader: zip_getReader,
    getWriter: zip_getWriter,
    extract: zip_extract,
    downloadAndExtract: zip_downloadAndExtract,
    inflateEntries: zip_inflateEntries,
    inflate: zip_inflate,
    _getPlatformSpecificFunctions: zip_getPlatformSpecificFunctions,
  };

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
    global.CordovaZipFileSystem.file.read({
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
          global.CordovaZipFileSystem.file.write({
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
        global.CordovaZipFileSystem.file.write(fileOptions, function onWriteFileDone(err, fileEntry, evt) {
          if (!!err) {
            ++numFilesErrored;
            onDone(err);
            return;
          }

          ++numFilesWritten;
          console.log('File written:', fileInfo,
            'numFilesWritten:', numFilesWritten,
            // 'evt.target.localURL:', evt.target.localURL,
            'urlOfFileEntry(fileEntry)', global.CordovaZipFileSystem.platform.urlOfFileEntry(fileEntry)
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
          global.CordovaZipFileSystem.directory.makeTree(dirs, function onCompleteRootTree(errors) {
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
          global.CordovaZipFileSystem.directory.makeTree(dirs, function onCompleteRootTree(errors) {
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

  function zip_getPlatformSpecificFunctions() {
    return {};
  }

})(this);

