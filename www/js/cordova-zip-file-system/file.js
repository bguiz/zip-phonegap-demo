'use strict';

(function(global) {
  if (!global.zip) {
    throw 'zip library is unavailable - cannot continue';
  }
  var zip = global.zip;

  global.CordovaZipFileSystem = global.CordovaZipFileSystem || {};

  global.CordovaZipFileSystem.file = {
    getEntry: file_getEntry,
    read: file_read,
    write: file_write,
    
    _initialise: file_initialise,
  };

  function file_getEntry(path, options, onGotFileEntry) {
    options = options || {};
    global.CordovaZipFileSystem.platform.getFileSystemRoot(function onGotFileSytemRoot(fsRoot) {
      // console.log('fileSys:', fileSys);
      if (!!options.mkdirp) {
        var dirPath = path.replace( /\/[^\/]+$/ , '');
        global.CordovaZipFileSystem.directory.makeRecursive(fsRoot, dirPath, function onMkdirpDone(err, dirEntry) {
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

  var getFile, writeBlobToFile, readFileImpl;

  function file_initialise(platformCategory) {
    if (platformCategory === 'windows') {
      getFile = _windows_getFile;
      writeBlobToFile = _windows_writeBlobToFile;
      readFileImpl = _windows_readFileImpl;
    }
    else {
      getFile = _regular_getFile;
      writeBlobToFile = _regular_writeBlobToFile;
      readFileImpl = _regular_readFileImpl;
    }

    global.CordovaZipFileSystem.file.getFile = getFile;
    global.CordovaZipFileSystem.file.writeBlobToFile = writeBlobToFile;
    global.CordovaZipFileSystem.file.readFileImpl = readFileImpl;
  }

})(this);

