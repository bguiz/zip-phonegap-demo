'use strict';

var MAX_CONCURRENT_INFLATE = 512;
var MAX_CONCURRENT_SIZE_COST = 2 * 1024 * 1024;

function onFail(err) {
  console.log(err);
  throw err;
}

function writeOutMessage(message) {
  var elem = document.getElementById('out');
  elem.appendChild(document.createTextNode(message));
  elem.appendChild(document.createElement('br'));
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
    readerType: 'HttpReader',
    readerUrl: options.readerUrl,
    writerType: 'BlobWriter',
    preemptiveTreeMkdir: true,
    extractFolder: options.extractFolder,
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
          'fileEntry.toURL()', fileEntry.toURL());
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
    writeOutMessage('Error: '+err);
    writeOutMessage('Error: '+err.stack);

    onFail(err);
  });
}

function getDataFile(path, options, onGotFileEntry) {
  options = options || {};
  window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, function onGotFileSytem(fileSys) {
    // console.log('fileSys:', fileSys);
    if (options.mkdirp) {
      var dirPath = path.replace( /\/[^\/]+$/ , '');
      mkdirp(fileSys.root, dirPath, function onMkdirpDone(err, dirEntry) {
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
      fileSys.root.getFile(path, options, function(fileEntry) {
        // console.log('fileEntry:', fileEntry);
        onGotFileEntry(undefined, fileEntry);
      }, onFail);
    }
  }, onFail);
}

function writeFile(options, onDone) {
  getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
    if (!!err) {
      onFail(err);
    }
    fileEntry.createWriter(function onWriterCreated(writer) {
      var blob;
      if (options.blob) {
        blob = options.blob;
      }
      else if (options.content && options.mimeType) {
        blob = new Blob([options.contents], { type: options.mimeType });
      }
      else {
        throw 'Cannot create file, invalid options';
      }
      writer.onwriteend = onWrote;
      writer.write(blob);

      function onWrote(evt) {
        onDone(writer.error, evt, fileEntry);
      }
    }, onFail);
  }, onFail);
}

function readFile(options, onDone) {
  getDataFile(options.name, options.flags, function onGotFileEntry(err, fileEntry) {
    if (!!err) {
      onFail(err);
    }
    fileEntry.file(function onGotFile(file) {
      var reader = new FileReader();
      reader.onloadend = onRead;
      switch(options.method) {
        case 'readAsText':
        case 'readAsDataURL':
        case 'readAsBinaryString':
        case 'readAsArrayBuffer':
          reader[options.method](file);
          break;
        default:
          throw 'Unrecognised file reader method: '+ options.method;
      }

      function onRead(evt) {
        onDone(reader.error, evt);
      }
    }, onFail);
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

    function mkdir(dir) {
      // console.log('mkdir', dir);
      fsRoot.getDirectory(dir, {
        create : true,
        exclusive : false,
      }, onCreateDirSuccess, onCreateDirFailure);
    }

    function mkdirSub() {
      if (dirs.length > 0) {
        mkdir(dirs.pop());
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

    mkdir(dirs.pop());
}

/**
 * Make a list of directories efficiently,
 * by constructing a tree data structure
 *
 * @param  {Array<String>}  dirs               A list of directories that need to be constructed
 * @param  {Function}       onCompleteRootTree Gets called once complete, the first parameter will be an array of errors
 */
function treeMkdir(dirs, onCompleteRootTree) {
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

  // Now recur through the nodes in the tree, breadth-first search,
  // and mkdir each node in turn
  // This ensures that the minimum number of mkdirs is needed
  window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, function onGotFileSytem(fileSys) {
    var errors = [];

    // var erroredSubTrees = 0;
    // var createdSubTrees = 0;
    // var completedSubTrees = 0;
    // var startedSubTrees = 0;
    // var totalSubTrees = 0;

    mkdirTree('', tree, onCompleteRootTree);

    function mkdirTree(path, node, onCompleteTree) {
      var subDirs = Object.keys(node);
      var numSubDirs = subDirs.length;
      // totalSubTrees += numSubDirs;

      if (numSubDirs === 0) {
        // Termination condition
        onCompleteTree();
        return;
      }

      var numLocalAttempts = 0;

      subDirs.forEach(function eachSubDir(subDir) {
        // ++startedSubTrees;
        var subDirPath = (path.length > 0) ? path+'/'+subDir : subDir;
        var subNode = node[subDir];

        mkdir(subDirPath, function onCreateDirSuccess(dirEntry) {
          // ++createdSubTrees;
          // Recur
          mkdirTree(subDirPath, subNode, function onCompleteSubTree() {
            ++numLocalAttempts;
            // checkCompletedSubdirs();
            // ++completedSubTrees;
            if (numLocalAttempts >= numSubDirs) {
              onCompleteTree(errors);
            }
          });
        }, function onCreateDirFailure(err) {
          ++numLocalAttempts;
          // ++erroredSubTrees;
          errors.push({
            err: err,
            path: path,
            subDir: subDir,
          });
          // checkCompletedSubdirs();
          if (numLocalAttempts >= numSubDirs) {
            onCompleteTree(errors);
          }
        });
      });

      // function checkCompletedSubdirs() {
      //   console.log('path', path, 'total', totalSubTrees, 'completed', completedSubTrees,
      //     'created', createdSubTrees, 'started', startedSubTrees, 'errored', erroredSubTrees);
      //   if (startedSubTrees >= totalSubTrees &&
      //     completedSubTrees >= createdSubTrees &&
      //     erroredSubTrees + createdSubTrees >=  totalSubTrees) {
      //     // // Exit this recursion
      //     // onCompleteTree();
      //     console.log('COMPLETE!');
      //   }
      // }
    }

    function mkdir(dirPath, onCreateDirSuccess, onCreateDirFailure) {
      // console.log('mkdir', dirPath);
      fileSys.root.getDirectory(dirPath, {
        create : true,
        exclusive : false,
      }, onCreateDirSuccess, onCreateDirFailure);
    }
  });
}

function getZipReader(options) {
  var reader;
  switch (options.readerType) {
    case 'TextReader':
      reader = new zip.TextReader(options.readerText);
      break;
    case 'BlobReader':
      reader = new zp.BlobReader(options.readerBlob);
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
