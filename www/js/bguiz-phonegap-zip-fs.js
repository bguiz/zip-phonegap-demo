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
        preemptiveTreeMkdir: true,
        blob: fileInfo.contents,
      };
      ++numFiles;
      writeFile(fileOptions, function onWriteFileDone(err, evt) {
        if (!!err) {
          ++numFilesErrored;
          onFail(err);
        }
        ++numFilesWritten;
        console.log('File written:', fileInfo, 'numFilesWritten:', numFilesWritten);
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
        onDone(undefined, numFiles);
      }
    }
  });
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
        var tree = {};
        entries.map(function dirOfFile(entry) {
          return entry.filename.replace( /\/[^\/]+$/ , '');
        }).forEach(function addToTree(dir) {
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

          mkdirTree('', tree, onCompleteRootTree() {
            console.log('mkdir tree completed, errors:', errors);
            inflateEntries();
          });

          function mkdirTree(path, node, onCompleteTree) {
            var subDirs = Object.keys(node);
            var numSubdirs = subDirs.length;

            if (numSubdirs === 0) {
              // Termination condition
              onCompleteTree();
            }

            var createdSubdirs = 0;
            var erroredSubdirs = 0;
            var completedSubTrees = 0;
            for (var i = 0; i < numSubdirs; ++i) {
              var subDir = subDirs[i];
              mkdir(subDir, function onCreateDirSuccess(dirEntry) {
                // Recursion
                var subPath = (path.length > 0) ? path+'/'+subDir : subDir;
                var subNode = node[subDir];
                mkdirTree(subPath, subNode, function onCompleteSubTree() {
                  ++completedSubTrees;
                  checkCompletedSubdirs();
                });
                ++createdSubdirs;
                // checkCompletedSubdirs();
              }, function onCreateDirFailure(err) {
                ++erroredSubdirs;
                errors.push({
                  {
                    err: err,

                  }
                });
                checkCompletedSubdirs();
              });
            }

            function checkCompletedSubdirs() {
              if (createdSubdirs + erroredSubdirs >= numSubdirs &&
                completedSubTrees >= createdSubdirs) {
                // Exit this level of recursion
                onCompleteTree();
              }
            }
          }

          function mkdir(dir, onCreateDirSuccess, onCreateDirFailure) {
            // console.log('mkdir', dir);
            fileSys.getDirectory(dir, {
              create : true,
              exclusive : false,
            }, onCreateDirSuccess, onCreateDirFailure);
          }
        });
      }
      else {
        inflateEntries();
      }

      function inflateEntries() {
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
            onDone(undefined, false, {
              fileEntry: entry,
              contents: data,
            });

            --concurrentEntries;
            --resultCount;
            concurrentCost -= estimatedSizeCost;
            if (resultCount < 1) {
              onDone(undefined, true);
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
          while (concurrentEntries < 1 ||
                 (concurrentEntries <= MAX_CONCURRENT_INFLATE &&
                  concurrentCost <= MAX_CONCURRENT_SIZE_COST)) {
            doNextEntry();
          }
        }

        doRateLimitedNextEntries();
      }
    });
  }, function onZipReaderCreateFailed(err) {
    console.error(err, err.stack);

    writeOutMessage('Error: '+err);
    writeOutMessage('Error: '+err.stack);

    throw err;
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
        onDone(writer.error, evt);
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
      // TODO start doing some form of optimisation like this
      // if (!!err && err.code === FileError.PATH_EXISTS_ERR) {
      //   // We can safely ignore any errors that occur
      //   // as a result of the directory already existing.
      //   //
      //   // In fact, we use `exclusive: true`to intentionally trip up this error
      //   // in order to shortcut to safety to performance optimisation reasons.
      //   mkdirSub();
      // }
      // else {
      //   console.log('mkdir fail', err, !!err && err.stack);
      //   throw err;
      // }
      console.log('mkdir fail', err, !!err && err.stack);
      throw err;
    }

    mkdir(dirs.pop());
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
